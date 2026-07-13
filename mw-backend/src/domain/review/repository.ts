// Domain-layer Review repository — enhanced canonical fingerprint + suppression.
//
// This is the Agent A (review-storage) enhanced repository that uses the
// canonical fingerprint service (src/domain/review/fingerprint.ts) with
// stable JSON key sorting. It is MORE comprehensive than the legacy
// src/review/repository.ts fingerprint, which only hashed type|figure|risk|body.
//
// Invariants (contract §0, §8, §9):
//   - PostgreSQL is the source of truth; Redis mirrors as cache only.
//   - evidenceFingerprint is computed server-side canonically (§8).
//   - duplicate suppression follows §9 (active vs decided vs archived).
//   - forceReopen=true bypasses suppression.
//   - ReviewDecision is append-only.
//
// Status enums and legacy mappings are re-exported from the Phase 1+2
// repository to avoid drift.

import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import crypto from "node:crypto";
import { computeCanonicalFingerprint, buildEvidence, type CanonicalEvidence } from "./fingerprint";

// Re-export contract enums from the Phase 1+2 repository (single source).
export {
  REVIEW_STATUS,
  LEGACY_STATUS_MAP,
  REVIEW_TYPES,
  REVIEW_RISK_TYPES,
  REVIEW_ACTIONS,
  USER_ROLES,
  ACTIVE_STATUSES,
  DECIDED_STATUSES,
} from "../../review/repository";
export type {
  ReviewStatus,
  ReviewType,
  ReviewRiskType,
  ReviewAction,
  UserRole,
} from "../../review/repository";

import {
  LEGACY_STATUS_MAP,
  ACTIVE_STATUSES,
  DECIDED_STATUSES,
  type ReviewStatus,
} from "../../review/repository";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CandidateAsset {
  hash?: string | null;
  source?: string;
  url?: string;
  cachedUrl?: string;
  imageId?: string | number;
  width?: number;
  height?: number;
  fileSize?: number;
  aspectRatio?: number;
}

export interface CreateReviewInput {
  type: string;
  title: string;
  figureId?: string | number | bigint | null;
  figureSlug?: string;
  riskType?: string;
  riskReason?: string;
  status?: string;
  priority?: number;
  confidence?: number;
  source?: string;
  sourceId?: string;

  // Canonical evidence fields (drive the fingerprint)
  primaryImageId?: string | number | null;
  imageIds?: (string | number)[];
  candidateAsset?: CandidateAsset;
  description?: string;
  spec?: Record<string, unknown>;
  category?: string;
  extraRiskFields?: Record<string, unknown>;

  // Client-supplied fingerprint (must match canonical recompute)
  evidenceFingerprint?: string;

  // Reopen control
  forceReopen?: boolean;
  reopenReason?: string;

  // Storage fields
  suggestedAction?: string;
  payload?: Record<string, unknown>;
  notes?: string;
  automation?: Record<string, unknown>;
  candidateImage?: Record<string, unknown>; // legacy compat (mirrored to candidateAsset)
  currentPublicImage?: Record<string, unknown>;
  originalEvidence?: Record<string, unknown>;
  currentStateSnapshot?: Record<string, unknown>;
  detailSnapshot?: Record<string, unknown>;
  crawlerJobId?: string;
}

export interface SuppressionResult {
  created: boolean;
  item: Record<string, unknown>;
  suppressed: boolean;
  reason: "duplicate_active" | "duplicate_decided" | null;
}

export interface RecordDecisionOpts {
  reviewItemId: string;
  action: string;
  statusAfter: ReviewStatus | string;
  reviewerId?: bigint | null;
  reviewerRole: string;
  decisionReason?: string;
  crawlerJobId?: string;
  candidateImageHash?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class FingerprintMismatchError extends Error {
  constructor(public expected: string, public supplied: string) {
    super(
      "evidenceFingerprint mismatch: client-supplied fingerprint does not match canonical recompute",
    );
    this.name = "FingerprintMismatchError";
  }
}

export class ReviewItemNotFoundError extends Error {
  constructor(public id: string) {
    super(`Review item not found: ${id}`);
    this.name = "ReviewItemNotFoundError";
  }
}

export class IllegalReviewTransitionError extends Error {
  constructor(public from: string, public to: string, public itemId?: string) {
    super(`Illegal review status transition: ${from} → ${to}${itemId ? ` (item ${itemId})` : ""}`);
    this.name = "IllegalReviewTransitionError";
  }
}

// ─── Legal status transitions (contract §2) ──────────────────────────────────

const REVIEW_TRANSITIONS: Record<string, string[]> = {
  pending: ["needs_changes", "resolved", "rejected", "archived", "pending"],
  needs_changes: ["pending", "resolved", "archived", "needs_changes"],
  resolved: ["pending", "archived"], // reopen on evidence change
  rejected: ["pending", "archived"], // reopen on evidence change
  archived: ["pending"], // human explicit reopen only
};

export function assertLegalReviewTransition(
  from: ReviewStatus | string,
  to: ReviewStatus | string,
  itemId?: string,
): void {
  const fromCanonical = LEGACY_STATUS_MAP[from as string] ?? (from as ReviewStatus);
  const toCanonical = LEGACY_STATUS_MAP[to as string] ?? (to as ReviewStatus);
  const legal = REVIEW_TRANSITIONS[fromCanonical];
  if (!legal || !legal.includes(toCanonical)) {
    throw new IllegalReviewTransitionError(from, to, itemId);
  }
}

// ─── Domain Review Repository ────────────────────────────────────────────────

export class DomainReviewRepository {
  constructor(
    private prisma: PrismaClient,
    private redis: Redis,
  ) {}

  // ── Canonical fingerprint (uses stable key sorting) ──
  computeFingerprint(input: CreateReviewInput): string {
    const evidence = buildEvidence({
      figureId: input.figureId,
      riskType: input.riskType,
      primaryImageId: input.primaryImageId,
      imageIds: input.imageIds,
      candidateAssetHash: input.candidateAsset?.hash ?? null,
      description: input.description,
      spec: input.spec,
      category: input.category,
      extraRiskFields: input.extraRiskFields,
    });
    return computeCanonicalFingerprint(evidence);
  }

  // ── Build CanonicalEvidence from input (exposed for testing) ──
  buildEvidence(input: CreateReviewInput): CanonicalEvidence {
    return buildEvidence({
      figureId: input.figureId,
      riskType: input.riskType,
      primaryImageId: input.primaryImageId,
      imageIds: input.imageIds,
      candidateAssetHash: input.candidateAsset?.hash ?? null,
      description: input.description,
      spec: input.spec,
      category: input.category,
      extraRiskFields: input.extraRiskFields,
    });
  }

  reconcileStatus(raw: string | undefined): ReviewStatus {
    const v = raw ?? "pending";
    if (LEGACY_STATUS_MAP[v as string]) return LEGACY_STATUS_MAP[v as string];
    return "pending";
  }

  // ── id generation (sortable, monotonic-ish) ──
  generateId(): string {
    const time = Date.now();
    const rand = crypto.randomBytes(8).toString("hex");
    return `01${time.toString(36).padStart(9, "0")}${rand}`;
  }

  // ── §9 create with duplicate suppression ──
  async create(input: CreateReviewInput): Promise<SuppressionResult> {
    const canonicalFp = this.computeFingerprint(input);
    if (input.evidenceFingerprint && input.evidenceFingerprint !== canonicalFp) {
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
        candidateAsset: (input.candidateAsset as any) ?? null,
        currentPublicImage: (input.currentPublicImage as any) ?? null,
        originalEvidence: (input.originalEvidence as any) ?? null,
        currentStateSnapshot: (input.currentStateSnapshot as any) ?? null,
        detailSnapshot: (input.detailSnapshot as any) ?? null,
        suggestedAction: input.suggestedAction ?? null,
        payload: (input.payload as any) ?? null,
        notes: input.notes ?? null,
        evidenceFingerprint: canonicalFp,
        forceReopen,
        crawlerJobId: input.crawlerJobId ?? null,
        automation: (input.automation as any) ?? null,
        createdAt: now,
        updatedAt: now,
      },
    });

    await this.mirrorToRedis(row);

    return { created: true, item: this.serialize(row), suppressed: false, reason: null };
  }

  // ── Record a human/automation decision (append-only) ──
  async recordDecision(opts: RecordDecisionOpts): Promise<{
    item: Record<string, unknown>;
    decision: Record<string, unknown>;
  }> {
    const existing = await this.prisma.reviewItem.findUnique({
      where: { id: opts.reviewItemId },
    });
    if (!existing) {
      throw new ReviewItemNotFoundError(opts.reviewItemId);
    }

    const previousStatus = this.reconcileStatus(existing.status as string);
    const nextStatus = this.reconcileStatus(opts.statusAfter as string);

    // State transition validation (§2)
    assertLegalReviewTransition(previousStatus, nextStatus, opts.reviewItemId);

    const now = new Date();

    const tx = await this.prisma.$transaction(async (db) => {
      const decision = await db.reviewDecision.create({
        data: {
          reviewItemId: opts.reviewItemId,
          action: String(opts.action),
          previousStatus,
          nextStatus,
          reviewerId: opts.reviewerId ?? null,
          reviewerRole: String(opts.reviewerRole),
          decisionReason: opts.decisionReason ?? null,
          crawlerJobId: opts.crawlerJobId ?? null,
          candidateImageHash: opts.candidateImageHash ?? null,
          evidenceFingerprint: existing.evidenceFingerprint,
          requestId: opts.requestId ?? null,
          metadata: (opts.metadata as any) ?? null,
        },
      });

      const updated = await db.reviewItem.update({
        where: { id: opts.reviewItemId },
        data: {
          status: nextStatus,
          lastAction: String(opts.action),
          reviewerId: opts.reviewerId ?? null,
          decisionReason: opts.decisionReason ?? null,
          decisionAt: now,
          crawlerJobId: opts.crawlerJobId ?? existing.crawlerJobId,
          updatedAt: now,
        },
      });

      return { decision, updated };
    });

    // Invalidate cache
    await this.redis.del(`review:item:${opts.reviewItemId}`);

    return {
      item: this.serialize(tx.updated),
      decision: {
        id: tx.decision.id.toString(),
        action: tx.decision.action,
        previousStatus: tx.decision.previousStatus,
        nextStatus: tx.decision.nextStatus,
        crawlerJobId: tx.decision.crawlerJobId,
        requestId: tx.decision.requestId,
        createdAt: tx.decision.createdAt.toISOString(),
      },
    };
  }

  // ── §9 helper: find an active (non-archived) item by fingerprint ──
  async findActiveByFingerprint(fingerprint: string) {
    return this.prisma.reviewItem.findFirst({
      where: {
        evidenceFingerprint: fingerprint,
        status: { not: "archived" },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  // ── Get by id (read-through cache) ──
  async getById(id: string): Promise<Record<string, unknown> | null> {
    const cached = await this.redis.get(`review:item:${id}`);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
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

  // ── List with filters ──
  async list(opts: {
    status?: string;
    type?: string;
    riskType?: string;
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

  // ── Reopen: transition a terminal/archived item back to pending ──
  async reopen(
    reviewItemId: string,
    reopenReason: string,
    reviewerId?: bigint | null,
  ): Promise<Record<string, unknown>> {
    const existing = await this.prisma.reviewItem.findUnique({
      where: { id: reviewItemId },
    });
    if (!existing) {
      throw new ReviewItemNotFoundError(reviewItemId);
    }
    const currentStatus = this.reconcileStatus(existing.status as string);
    assertLegalReviewTransition(currentStatus, "pending", reviewItemId);

    const now = new Date();
    const tx = await this.prisma.$transaction(async (db) => {
      const decision = await db.reviewDecision.create({
        data: {
          reviewItemId,
          action: "reopen",
          previousStatus: currentStatus,
          nextStatus: "pending",
          reviewerId: reviewerId ?? null,
          reviewerRole: "admin",
          decisionReason: reopenReason,
          evidenceFingerprint: existing.evidenceFingerprint,
        },
      });
      const updated = await db.reviewItem.update({
        where: { id: reviewItemId },
        data: {
          status: "pending",
          lastAction: "reopen",
          reviewerId: reviewerId ?? null,
          decisionReason: reopenReason,
          decisionAt: now,
          forceReopen: false,
          updatedAt: now,
        },
      });
      return { decision, updated };
    });

    await this.redis.del(`review:item:${reviewItemId}`);
    return this.serialize(tx.updated);
  }

  // ── Serialize a PG row for API output (BigInt-safe) ──
  private serialize(row: any): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row };
    for (const key of ["figureId", "reviewerId"]) {
      if (out[key] != null && typeof out[key] === "bigint") {
        out[key] = (out[key] as bigint).toString();
      }
    }
    if (out.id && typeof row.id === "bigint") {
      out.id = row.id.toString();
    }
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
