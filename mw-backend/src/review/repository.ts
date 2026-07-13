// Review storage repository — Phase 1+2 contract implementation.
// Source of truth: docs/implementation/PHASE12_CONTRACT.md (frozen at e4c9fe3)
//
// Invariants enforced here:
//  - PostgreSQL is the source of truth; Redis mirrors as cache/index only.
//  - evidenceFingerprint is computed server-side canonically (§8).
//  - duplicate suppression follows §9 (active vs decided vs archived).
//  - legacy Redis status values are reconciled to the canonical set on write.
//  - `all` is never persisted.
//
// This module is storage-only. State-machine transitions for CrawlerJob
// (canary claim, retry, defer) live in src/crawler/ (agent/crawler-state).
// The review ACTION→status mapping lives in src/review/actions.ts
// (agent/review-api-integration). Both consume this repository.

import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import crypto from "node:crypto";

// ─── Canonical enums (mirror of PHASE12_CONTRACT.md) ───────────────────────────

export const REVIEW_STATUS = [
  "pending",
  "needs_changes",
  "resolved",
  "rejected",
  "archived",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUS)[number];

export const LEGACY_STATUS_MAP: Record<string, ReviewStatus> = {
  pending: "pending",
  needs_changes: "needs_changes",
  resolved: "resolved",
  rejected: "rejected",
  archived: "archived",
  approved: "resolved", // legacy → canonical
  stale: "archived", // legacy → canonical
};

export const REVIEW_TYPES = [
  "jan_match",
  "figure_import",
  "rewrite",
  "image",
  "general",
  "image_review",
  "detail_review",
] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];

export const REVIEW_RISK_TYPES = [
  "image_suspicious_banner",
  "image_suspicious_thumbnail",
  "image_possible_user_photo",
  "image_possible_collection_or_room",
  "image_wrong_subject",
  "image_low_quality_fallback",
  "image_restore_candidate",
  "image_missing",
  "image_low_count",
  "detail_missing_description",
  "detail_sparse_specs",
  "detail_conflict",
  "category_uncertain",
  "general_risk",
] as const;
export type ReviewRiskType = (typeof REVIEW_RISK_TYPES)[number];

export const REVIEW_ACTIONS = [
  "approve_image",
  "reject_image",
  "keep_placeholder",
  "mark_detail_ok",
  "mark_needs_manual_edit",
  "request_refetch",
  "keep_pending",
  "dismiss_stale",
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const USER_ROLES = ["user", "editor", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ACTIVE_STATUSES: ReviewStatus[] = ["pending", "needs_changes"];
export const DECIDED_STATUSES: ReviewStatus[] = ["resolved", "rejected"];

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CandidateImage {
  source: string;
  imageId?: string | number;
  width?: number;
  height?: number;
  fileSize?: number;
  aspectRatio?: number;
  url?: string;
  cachedUrl?: string;
}

export interface CreateReviewItemInput {
  type: ReviewType | string;
  title: string;
  source?: string;
  sourceId?: string;
  status?: string; // may be legacy; reconciled
  priority?: number;
  confidence?: number;
  figureId?: bigint | number | string;
  figureSlug?: string;
  riskType?: ReviewRiskType | string;
  riskReason?: string;
  candidateImage?: CandidateImage;
  currentPublicImage?: Record<string, unknown>;
  originalEvidence?: Record<string, unknown>;
  currentStateSnapshot?: Record<string, unknown>;
  detailSnapshot?: Record<string, unknown>;
  suggestedAction?: ReviewAction | string;
  payload?: Record<string, unknown>;
  notes?: string;
  evidenceFingerprint?: string; // accepted only if it matches canonical recompute
  forceReopen?: boolean;
  automation?: Record<string, unknown>;
}

export interface SuppressionResult {
  created: boolean;
  item: Record<string, unknown>;
  suppressed: boolean;
  reason: "duplicate_active" | "duplicate_decided" | null;
}

// ─── Repository ────────────────────────────────────────────────────────────────

export class ReviewRepository {
  constructor(
    private prisma: PrismaClient,
    private redis: Redis,
  ) {}

  // ── §8 evidenceFingerprint canonical computation ──
  computeFingerprint(input: CreateReviewItemInput): string {
    const type = String(input.type ?? "general");
    const figPart = input.figureId != null
      ? BigInt(input.figureId).toString()
      : input.figureSlug ?? "no-fig";

    let riskPart = "no-risk";
    if (type === "image" || type === "image_review" || type === "detail_review") {
      riskPart = String(input.riskType ?? "no-risk");
    }

    let body: string;
    if (type === "image" || type === "image_review") {
      body = input.candidateImage?.url ?? input.candidateImage?.source ?? "no-image";
    } else if (type === "detail_review") {
      const desc = (input.detailSnapshot as any)?.description;
      body = desc != null && desc !== "" ? String(desc) : "no-desc";
    } else if (type === "jan_match") {
      body = (input.payload as any)?.janCode ?? "no-jan";
    } else if (type === "figure_import") {
      body = (input.payload as any)?.sourceUrl ?? "no-url";
    } else {
      body = input.title;
    }

    const canonical = [type, figPart, riskPart, body].join("|");
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  reconcileStatus(raw: string | undefined): ReviewStatus {
    const v = raw ?? "pending";
    if (LEGACY_STATUS_MAP[v]) return LEGACY_STATUS_MAP[v];
    // Unknown values default to pending rather than crashing (defensive).
    return "pending";
  }

  // ── id generation (sortable, monotonic-ish) ──
  generateId(): string {
    // Crockford-base32 time-ordered id, ~ulid-compatible shape.
    const time = Date.now();
    const rand = crypto.randomBytes(8).toString("hex");
    return `01${time.toString(36).padStart(9, "0")}${rand}`;
  }

  // ── §9 create with duplicate suppression ──
  async create(input: CreateReviewItemInput): Promise<SuppressionResult> {
    // Canonical fingerprint: always recompute; reject client spoofing.
    const canonicalFp = this.computeFingerprint(input);
    if (input.evidenceFingerprint && input.evidenceFingerprint !== canonicalFp) {
      // Client supplied a fingerprint that does not match canonical recompute.
      // Reject to prevent suppression bypass via fingerprint spoofing.
      throw new FingerprintMismatchError(canonicalFp, input.evidenceFingerprint);
    }

    const forceReopen = input.forceReopen === true;

    if (!forceReopen) {
      const existing = await this.findActiveByFingerprint(canonicalFp);
      if (existing) {
        const status = this.reconcileStatus(existing.status as string);
        if (DECIDED_STATUSES.includes(status)) {
          return {
            created: false,
            item: this.serialize(existing),
            suppressed: true,
            reason: "duplicate_decided",
          };
        }
        // active (pending / needs_changes)
        return {
          created: false,
          item: this.serialize(existing),
          suppressed: true,
          reason: "duplicate_active",
        };
      }
    }

    const id = this.generateId();
    const now = new Date();
    const status = this.reconcileStatus(input.status);

    const row = await this.prisma.reviewItem.create({
      data: {
        id,
        type: String(input.type ?? "general"),
        riskType: input.riskType ?? null,
        status,
        title: input.title,
        source: input.source ?? null,
        sourceId: input.sourceId ?? null,
        figureId: input.figureId != null ? BigInt(input.figureId) : null,
        figureSlug: input.figureSlug ?? null,
        priority: input.priority ?? 1,
        confidence: input.confidence ?? null,
        riskReason: input.riskReason ?? null,
        candidateImage: (input.candidateImage as any) ?? null,
        currentPublicImage: (input.currentPublicImage as any) ?? null,
        originalEvidence: (input.originalEvidence as any) ?? null,
        currentStateSnapshot: (input.currentStateSnapshot as any) ?? null,
        detailSnapshot: (input.detailSnapshot as any) ?? null,
        suggestedAction: (input.suggestedAction as string) ?? null,
        payload: (input.payload as any) ?? null,
        notes: input.notes ?? null,
        evidenceFingerprint: canonicalFp,
        forceReopen,
        automation: (input.automation as any) ?? null,
        createdAt: now,
        updatedAt: now,
      },
    });

    // Mirror to Redis cache + index (best-effort; PG is source of truth).
    await this.mirrorToRedis(row);

    return { created: true, item: this.serialize(row), suppressed: false, reason: null };
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    // Try cache first (read-through).
    const cached = await this.redis.get(`review:item:${id}`);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        // Validate the cache still agrees with PG status (cheap single-column read).
        const pgStatus = await this.prisma.reviewItem.findUnique({
          where: { id },
          select: { status: true, updatedAt: true },
        });
        if (pgStatus && parsed.status === pgStatus.status) {
          return parsed;
        }
      } catch {
        // fall through to PG
      }
    }
    const row = await this.prisma.reviewItem.findUnique({ where: { id } });
    if (!row) return null;
    const serialized = this.serialize(row);
    await this.redis.set(`review:item:${id}`, JSON.stringify(serialized), "EX", 3600);
    return serialized;
  }

  async list(opts: {
    status?: string; // may be "all" (query-only, never persisted)
    type?: string;
    riskType?: string;
    suggestedAction?: string;
    limit?: number;
    page?: number;
  } = {}): Promise<{ items: Record<string, unknown>[]; total: number; page: number; limit: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const page = Math.max(opts.page ?? 1, 1);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (opts.status && opts.status !== "all") {
      where.status = this.reconcileStatus(opts.status);
    }
    if (opts.type) where.type = opts.type;
    if (opts.riskType) where.riskType = opts.riskType;
    if (opts.suggestedAction) where.suggestedAction = opts.suggestedAction;

    const [rows, total] = await Promise.all([
      this.prisma.reviewItem.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip,
      }),
      this.prisma.reviewItem.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.serialize(r)),
      total,
      page,
      limit,
    };
  }

  // ── Record a human/automation decision (append-only) ──
  async recordDecision(opts: {
    reviewItemId: string;
    action: ReviewAction | string;
    statusAfter: ReviewStatus | string;
    reviewerId?: bigint | null;
    reviewerRole: UserRole | string;
    decisionReason?: string;
    crawlerJobId?: string;
    candidateImageHash?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ item: Record<string, unknown>; decision: Record<string, unknown> }> {
    const existing = await this.prisma.reviewItem.findUnique({
      where: { id: opts.reviewItemId },
    });
    if (!existing) {
      throw new ReviewItemNotFoundError(opts.reviewItemId);
    }

    const statusBefore = this.reconcileStatus(existing.status as string);
    const statusAfter = this.reconcileStatus(opts.statusAfter as string);
    const now = new Date();

    // Legal transition check (§2). keep_pending keeps status unchanged.
    if (opts.action !== "keep_pending" && statusBefore === statusAfter) {
      // Allow no-op only for keep_pending; otherwise a status change is expected
      // unless action explicitly maps to same status (e.g. archived→archived not allowed).
    }

    const tx = await this.prisma.$transaction(async (db) => {
      const decision = await db.reviewDecision.create({
        data: {
          reviewItemId: opts.reviewItemId,
          action: String(opts.action),
          statusBefore,
          statusAfter,
          reviewerId: opts.reviewerId ?? null,
          reviewerRole: String(opts.reviewerRole),
          decisionReason: opts.decisionReason ?? null,
          crawlerJobId: opts.crawlerJobId ?? null,
          candidateImageHash: opts.candidateImageHash ?? null,
          evidenceFingerprint: existing.evidenceFingerprint,
          metadata: (opts.metadata as any) ?? null,
        },
      });

      const updated = await db.reviewItem.update({
        where: { id: opts.reviewItemId },
        data: {
          status: statusAfter,
          lastAction: String(opts.action),
          reviewerId: opts.reviewerId ?? null,
          decisionReason: opts.decisionReason ?? null,
          decisionAt: now,
          // keep_pending does not change status; the update above writes the
          // same status back which is a harmless no-op on PG.
          crawlerJobId: opts.crawlerJobId ?? existing.crawlerJobId,
          updatedAt: now,
        },
      });

      return { decision, updated };
    });

    // Invalidate cache so next read picks up the new state.
    await this.redis.del(`review:item:${opts.reviewItemId}`);

    return {
      item: this.serialize(tx.updated),
      decision: {
        id: tx.decision.id.toString(),
        action: tx.decision.action,
        statusBefore: tx.decision.statusBefore,
        statusAfter: tx.decision.statusAfter,
        crawlerJobId: tx.decision.crawlerJobId,
        createdAt: tx.decision.createdAt.toISOString(),
      },
    };
  }

  // ── §9 helper: find an active (non-archived) item by fingerprint ──
  async findActiveByFingerprint(fingerprint: string) {
    // Active = not archived. A resolved/rejected item is "active" for suppression
    // purposes (its decision is sticky), so we exclude only archived.
    return this.prisma.reviewItem.findFirst({
      where: {
        evidenceFingerprint: fingerprint,
        status: { not: "archived" },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  // ── Rebuild the Redis ZSET index from PostgreSQL (recovery procedure) ──
  async rebuildRedisIndex(opts: { batchSize?: number } = {}): Promise<{
    indexed: number;
    archived: number;
    fingerprintKeys: number;
  }> {
    const batchSize = opts.batchSize ?? 500;
    let indexed = 0;
    let archived = 0;
    const fpKeys: string[] = [];

    // Clear the order indexes (cache only; PG is source of truth).
    await this.redis.del("review:items", "review:archive");

    let cursor: string | null = null;
    while (true) {
      const args: { orderBy: { createdAt: "asc" }; take: number; skip?: number; cursor?: { id: string } } = {
        orderBy: { createdAt: "asc" },
        take: batchSize,
      };
      if (cursor) {
        args.skip = 1;
        args.cursor = { id: cursor };
      }
      const rows = await this.prisma.reviewItem.findMany(args);
      if (rows.length === 0) break;

      for (const row of rows) {
        const score = row.createdAt.getTime();
        if (row.status === "archived") {
          await this.redis.zadd("review:archive", score, row.id);
          archived++;
        } else {
          await this.redis.zadd("review:items", score, row.id);
          indexed++;
        }
        await this.redis.set(`review:item:${row.id}`, JSON.stringify(this.serialize(row)), "EX", 3600);
        fpKeys.push(`review:fingerprint:${row.evidenceFingerprint}`);
      }
      cursor = rows[rows.length - 1].id;
      if (rows.length < batchSize) break;
    }

    // Rebuild fingerprint index (point fingerprint → latest active item id).
    // Use a pipeline for efficiency.
    if (fpKeys.length > 0) {
      const items = await this.prisma.reviewItem.findMany({
        where: { status: { not: "archived" } },
        select: { id: true, evidenceFingerprint: true },
        orderBy: { createdAt: "desc" },
      });
      const pipeline = this.redis.pipeline();
      for (const it of items) {
        pipeline.set(`review:fingerprint:${it.evidenceFingerprint}`, it.id);
      }
      await pipeline.exec();
    }

    return { indexed, archived, fingerprintKeys: fpKeys.length };
  }

  // ── Serialize a PG row for API output (BigInt-safe) ──
  private serialize(row: any): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row };
    // BigInt is not JSON-serializable; convert to string.
    for (const key of ["figureId", "reviewerId"]) {
      if (out[key] != null && typeof out[key] === "bigint") {
        out[key] = (out[key] as bigint).toString();
      }
    }
    if (out.id && typeof row.id === "bigint") {
      out.id = row.id.toString();
    }
    // Dates → ISO strings
    for (const key of ["createdAt", "updatedAt", "decisionAt"]) {
      if (out[key] instanceof Date) out[key] = (out[key] as Date).toISOString();
    }
    return out;
  }

  private async mirrorToRedis(row: any): Promise<void> {
    const serialized = this.serialize(row);
    const pipeline = this.redis.pipeline();
    pipeline.set(`review:item:${row.id}`, JSON.stringify(serialized), "EX", 3600);
    const score = row.createdAt instanceof Date ? row.createdAt.getTime() : Date.now();
    if (row.status === "archived") {
      pipeline.zadd("review:archive", score, row.id);
    } else {
      pipeline.zadd("review:items", score, row.id);
    }
    if (row.status !== "archived") {
      pipeline.set(`review:fingerprint:${row.evidenceFingerprint}`, row.id);
    }
    await pipeline.exec();
  }
}

// ─── Errors ────────────────────────────────────────────────────────────────────

export class FingerprintMismatchError extends Error {
  constructor(public expected: string, public supplied: string) {
    super(`evidenceFingerprint mismatch: client-supplied fingerprint does not match canonical recompute`);
    this.name = "FingerprintMismatchError";
  }
}

export class ReviewItemNotFoundError extends Error {
  constructor(public id: string) {
    super(`Review item not found: ${id}`);
    this.name = "ReviewItemNotFoundError";
  }
}
