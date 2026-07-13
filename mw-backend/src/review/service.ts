// Phase 1+2 review-api-integration: service layer that enriches review items
// with current figure state, performs rechecks, and applies review actions
// with decision persistence to PostgreSQL.
//
// Contract reference: docs/implementation/PHASE12_CONTRACT.md
//   - section 4 (ReviewAction → ReviewStatus mapping)
//   - section 12 (API response structures: list enrichment, recheck, action)
//   - section 13 (Storage responsibility matrix)
//
// This module is the integration layer between:
//   - ReviewRepository (storage + fingerprint + suppression)
//   - CrawlerJobRepository (state machine + canary claim)
//   - Figure/Image Prisma models (current state at query time)
//
// Key invariants:
//   - currentStateSnapshot is computed at QUERY TIME, never stored
//   - originalEvidence is the frozen creation-time snapshot
//   - The two are always separate fields in API responses
//   - Every action records a ReviewDecision (append-only audit)
//   - request_refetch creates exactly one CrawlerJob (idempotent per fingerprint)
//
// Run tests: npx tsx --test src/review/service.test.ts

import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { ReviewRepository, type ReviewAction, type ReviewStatus } from "./repository.js";
import { CrawlerJobRepository } from "../crawler/stateMachine.js";

// ─── Action → Status mapping (contract §4) ───────────────────────────────────

export const ACTION_TO_STATUS: Record<ReviewAction, ReviewStatus> = {
  approve_image: "resolved",
  reject_image: "rejected",
  keep_placeholder: "resolved",
  mark_detail_ok: "resolved",
  mark_needs_manual_edit: "needs_changes",
  request_refetch: "needs_changes",
  keep_pending: "pending",
  dismiss_stale: "archived",
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CurrentStateSnapshot {
  figureId: string | null;
  figureSlug: string | null;
  figureName: string | null;
  imageCount: number;
  primaryImageId: string | null;
  primaryImageWidth: number | null;
  primaryImageHeight: number | null;
  descriptionLength: number;
  validSpecCount: number;
  missingFields: string[];
}

export interface RecheckResult {
  stillProblem: boolean;
  reason: string;
  eligibleResolve: boolean;
  problems: string[];
}

export interface ApplyActionOpts {
  reviewItemId: string;
  action: ReviewAction | string;
  reviewerId?: bigint | null;
  reviewerRole?: string;
  decisionReason?: string;
  candidateImage?: {
    source: string;
    imageId?: string | number;
    width?: number;
    height?: number;
    sha256?: string;
  };
  crawlerJobSource?: string;
  crawlerJobTask?: string;
  crawlerJobPayload?: any;
}

export interface ApplyActionResult {
  item: Record<string, unknown>;
  decision: Record<string, unknown>;
  crawlerJobId?: string;
  problems: string[];
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ReviewService {
  private readonly repo: ReviewRepository;
  private readonly crawlerRepo: CrawlerJobRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
  ) {
    this.repo = new ReviewRepository(prisma, redis);
    this.crawlerRepo = new CrawlerJobRepository(prisma, redis);
  }

  /**
   * Compute the current state snapshot for a figure at query time.
   * Per contract §12: "The list response MUST enrich each item with the
   * CURRENT figure state (currentStateSnapshot) computed server-side at
   * query time — never a stale snapshot stored at creation."
   */
  async computeCurrentStateSnapshot(
    figureId: bigint | null,
    figureSlug?: string | null,
  ): Promise<CurrentStateSnapshot> {
    if (!figureId && !figureSlug) {
      return this.emptySnapshot();
    }
    const figure = figureId
      ? await this.prisma.figure.findFirst({
          where: { id: figureId, isDeleted: false },
          select: {
            id: true, slug: true, name: true, description: true,
            scale: true, material: true, priceJpy: true, releaseDate: true,
            heightMm: true, weightG: true, productLine: true, ageRating: true,
            manufacturer: { select: { name: true } },
            series: { select: { name: true } },
          },
        })
      : await this.prisma.figure.findFirst({
          where: { slug: String(figureSlug), isDeleted: false },
          select: {
            id: true, slug: true, name: true, description: true,
            scale: true, material: true, priceJpy: true, releaseDate: true,
            heightMm: true, weightG: true, productLine: true, ageRating: true,
            manufacturer: { select: { name: true } },
            series: { select: { name: true } },
          },
        });
    if (!figure) return this.emptySnapshot();

    const images = await this.prisma.figureImage.findMany({
      where: { figureId: figure.id },
      select: { id: true, width: true, height: true, sortOrder: true, size: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });

    const primaryImage = images.find((img: any) => img.size === "detail") ?? images[0] ?? null;

    const specFields = [
      figure.scale, figure.material, figure.priceJpy,
      figure.releaseDate, figure.heightMm, figure.weightG,
      figure.productLine, figure.ageRating,
      figure.manufacturer?.name, figure.series?.name,
    ];
    const validSpecCount = specFields.filter((f) => f != null && f !== "").length;

    const missingFields: string[] = [];
    if (!figure.description || figure.description.length === 0) missingFields.push("description");
    if (!figure.scale) missingFields.push("scale");
    if (!figure.material) missingFields.push("material");
    if (!figure.priceJpy) missingFields.push("priceJpy");
    if (!figure.releaseDate) missingFields.push("releaseDate");
    if (!figure.manufacturer?.name) missingFields.push("manufacturer");
    if (!figure.series?.name) missingFields.push("series");

    return {
      figureId: figure.id.toString(),
      figureSlug: figure.slug,
      figureName: figure.name,
      imageCount: images.length,
      primaryImageId: primaryImage ? primaryImage.id.toString() : null,
      primaryImageWidth: primaryImage ? (primaryImage.width ? Number(primaryImage.width) : null) : null,
      primaryImageHeight: primaryImage ? (primaryImage.height ? Number(primaryImage.height) : null) : null,
      descriptionLength: figure.description ? figure.description.length : 0,
      validSpecCount,
      missingFields,
    };
  }

  private emptySnapshot(): CurrentStateSnapshot {
    return {
      figureId: null,
      figureSlug: null,
      figureName: null,
      imageCount: 0,
      primaryImageId: null,
      primaryImageWidth: null,
      primaryImageHeight: null,
      descriptionLength: 0,
      validSpecCount: 0,
      missingFields: [],
    };
  }

  /**
   * Enrich a review item with currentStateSnapshot.
   * The originalEvidence (item.payload) is preserved as-is — the two are
   * always separate fields per contract §12.
   */
  async enrichItem(item: Record<string, unknown>): Promise<Record<string, unknown>> {
    const figureId = item.figureId ? BigInt(String(item.figureId)) : null;
    const figureSlug = item.figureSlug ? String(item.figureSlug) : null;
    const currentStateSnapshot = await this.computeCurrentStateSnapshot(figureId, figureSlug);
    return {
      ...item,
      originalEvidence: item.payload ?? null,
      currentStateSnapshot,
    };
  }

  /**
   * Enrich a list of review items with currentStateSnapshot.
   */
  async enrichItems(items: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    return Promise.all(items.map((item) => this.enrichItem(item)));
  }

  /**
   * Recheck a review item against current figure state.
   * Per contract §12: returns { stillProblem, reason, eligibleResolve }.
   *
   * This refactors the existing evaluateReviewItem logic from admin.ts into
   * the service layer, making it testable and reusable.
   */
  async recheckItem(item: Record<string, unknown>): Promise<RecheckResult> {
    const problems = await this.evaluateProblems(item);
    const stillProblem = problems.length > 0;
    return {
      stillProblem,
      reason: stillProblem ? problems.join("; ") : "OK",
      eligibleResolve: !stillProblem,
      problems,
    };
  }

  /**
   * Evaluate problems against current figure state.
   * This is the core recheck logic — extracted from admin.ts evaluateReviewItem.
   */
  private async evaluateProblems(item: Record<string, unknown>): Promise<string[]> {
    const payload = (item.payload as Record<string, unknown>) || {};
    const problems: string[] = [];
    const type = String(item.type || "");
    const figureId = item.figureId ? BigInt(String(item.figureId)) : null;
    const figureSlug = item.figureSlug ? String(item.figureSlug) : null;

    if (["image", "image_review", "rewrite", "jan_match", "detail_review"].includes(type) && !figureId && !figureSlug) {
      problems.push("FIGURE_NOT_FOUND");
      return problems;
    }

    const figure = figureId
      ? await this.prisma.figure.findFirst({ where: { id: figureId, isDeleted: false }, select: { id: true, slug: true, janCode: true } })
      : figureSlug
      ? await this.prisma.figure.findFirst({ where: { slug: figureSlug, isDeleted: false }, select: { id: true, slug: true, janCode: true } })
      : null;

    if (["image", "image_review", "rewrite", "jan_match", "detail_review"].includes(type) && !figure) {
      problems.push("FIGURE_NOT_FOUND");
      return problems;
    }

    if (type === "image" && figure) {
      const rows = await this.prisma.figureImage.findMany({
        where: { figureId: figure.id },
        select: { id: true, source: true, size: true, width: true, height: true },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
      if (rows.length === 0) problems.push("仍然没有图片");
      const dupGroups = this.countDuplicateGroups(rows);
      if (dupGroups > 0) problems.push(`同一来源同一尺寸仍有 ${dupGroups} 组重复图片记录`);
    } else if (type === "image_review" && figure) {
      const rows = await this.prisma.figureImage.findMany({
        where: { figureId: figure.id },
        select: { id: true, source: true, size: true, width: true, height: true, data: true, sortOrder: true },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
      if (rows.length === 0) {
        problems.push("仍然没有图片");
      } else {
        const dupGroups = this.countDuplicateGroups(rows);
        if (dupGroups > 0) problems.push(`同一来源同一尺寸仍有 ${dupGroups} 组重复图片记录`);
        const riskType = String(item.riskType || "");
        if (riskType === "image_low_count") {
          const approved = rows.find((r: any) => {
            const kind = String((r.data || {}).source_kind || "");
            return kind === "mfc_review_approved" || kind === "trusted_retailer_image";
          });
          if (!approved) {
            problems.push("没有 mfc_review_approved 或可信 retailer 高清图，批准未生效");
          } else {
            const w = Number(approved.width) || 0;
            const h = Number(approved.height) || 0;
            if (w < 500 || h < 500) problems.push(`主图尺寸 ${w}x${h} 不足 500x500，仍为低清`);
            if (((approved.data || {}) as any).image_low_quality === true) {
              problems.push("主图仍标记 image_low_quality=true");
            }
          }
        }
        if (riskType === "image_missing" && rows.length === 0) {
          problems.push("仍然没有图片");
        }
      }
    } else if (type === "rewrite" && figure) {
      const activeRevision = await this.prisma.revision.findFirst({
        where: { figureId: figure.id, isActive: true },
        select: { id: true, contentMd: true },
      });
      if (!activeRevision || !activeRevision.contentMd || activeRevision.contentMd.trim().length < 80) {
        problems.push("洗稿正文仍为空或过短");
      }
    } else if (type === "detail_review" && figure) {
      const figureDetail = await this.prisma.figure.findUnique({
        where: { id: figure.id },
        select: {
          id: true, description: true, scale: true, material: true,
          priceJpy: true, releaseDate: true, heightMm: true, weightG: true,
          productLine: true, ageRating: true,
          manufacturer: { select: { name: true } },
          series: { select: { name: true } },
        },
      });
      if (!figureDetail) {
        problems.push("FIGURE_NOT_FOUND");
      } else {
        const riskType = String(item.riskType || "");
        if (riskType === "detail_missing_description") {
          const descLen = (figureDetail.description || "").length;
          if (descLen < 50) problems.push(`描述仅 ${descLen} 字符，仍不足`);
        }
        if (riskType === "detail_sparse_specs") {
          const specFields = [
            figureDetail.scale, figureDetail.material, figureDetail.priceJpy,
            figureDetail.releaseDate, figureDetail.heightMm, figureDetail.weightG,
            figureDetail.productLine, figureDetail.ageRating,
            figureDetail.manufacturer?.name, figureDetail.series?.name,
          ].filter((f) => f != null);
          if (specFields.length < 3) problems.push(`有效规格字段仅 ${specFields.length} 项，仍不足`);
        }
      }
    } else if (type === "jan_match" && figure) {
      const expectedJan = payload.janCode ? String(payload.janCode) : "";
      if (expectedJan && figure.janCode !== expectedJan) {
        problems.push(`JAN 仍未更新为 ${expectedJan}`);
      }
    }

    return problems;
  }

  private countDuplicateGroups(rows: any[]): number {
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!row.source) continue;
      const key = `${row.source}::${row.size}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.values()].filter((c) => c > 1).length;
  }

  /**
   * Apply a review action: record the decision, create crawler job if needed,
   * and return the updated item + decision + any problems.
   *
   * Per contract §4 + §12:
   *   - Each action maps to a target status (ACTION_TO_STATUS)
   *   - request_refetch creates exactly one CrawlerJob (idempotent)
   *   - Every action records a ReviewDecision (append-only audit)
   *   - Response includes decision: { id, action, statusBefore, statusAfter, crawlerJobId? }
   */
  async applyAction(opts: ApplyActionOpts): Promise<ApplyActionResult> {
    const action = String(opts.action) as ReviewAction;
    const targetStatus = ACTION_TO_STATUS[action] ?? "pending";

    // Fetch existing item to check for existing crawlerJobId (idempotency)
    const existing = await this.prisma.reviewItem.findUnique({
      where: { id: opts.reviewItemId },
    });
    if (!existing) {
      throw new Error(`ReviewItem not found: ${opts.reviewItemId}`);
    }

    // For request_refetch: create exactly one CrawlerJob (idempotent)
    let crawlerJobId: string | undefined;
    if (action === "request_refetch") {
      const existingJobId = (existing.payload as any)?.crawlerJobId;
      if (existingJobId) {
        // Idempotent: reuse existing crawlerJobId
        crawlerJobId = String(existingJobId);
      } else {
        // Create a new CrawlerJob in "created" state (not yet queued)
        const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await this.crawlerRepo.create({
          id: jobId,
          source: opts.crawlerJobSource ?? "manual",
          task: opts.crawlerJobTask ?? "refetch",
          runner: "server_safe",
          payload: opts.crawlerJobPayload ?? { figureId: String(existing.figureId) },
          linkedReviewItemId: opts.reviewItemId,
          notes: opts.decisionReason ?? undefined,
        });
        crawlerJobId = jobId;
      }
    }

    // Record the decision (append-only audit to PG)
    const { item, decision } = await this.repo.recordDecision({
      reviewItemId: opts.reviewItemId,
      action,
      statusAfter: targetStatus,
      reviewerId: opts.reviewerId ?? null,
      reviewerRole: opts.reviewerRole ?? "admin",
      decisionReason: opts.decisionReason,
      crawlerJobId,
      candidateImageHash: opts.candidateImage?.sha256,
      metadata: opts.candidateImage ? {
        candidateSource: opts.candidateImage.source,
        candidateImageId: opts.candidateImage.imageId,
        candidateWidth: opts.candidateImage.width,
        candidateHeight: opts.candidateImage.height,
      } : undefined,
    });

    // Recheck the item against current state
    const recheck = await this.recheckItem(item);

    return {
      item,
      decision,
      crawlerJobId,
      problems: recheck.problems,
    };
  }

  /**
   * List review items with enrichment.
   * Per contract §12: each item MUST include currentStateSnapshot.
   */
  async listEnriched(opts: {
    status?: string;
    type?: string;
    riskType?: string;
    suggestedAction?: string;
    limit?: number;
    page?: number;
  }): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    limit: number;
  }> {
    const result = await this.repo.list(opts);
    const enrichedItems = await this.enrichItems(result.items);
    return {
      items: enrichedItems,
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }
}
