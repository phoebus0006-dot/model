import crypto from "crypto";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@prisma/client";
import { ReviewRepository } from "./repository.js";
import {
  type ReviewItem, type ReviewDecision, type ReviewAction, type ReviewStatus,
  type BulkCleanupResult, REVIEW_ACTIONS, ACTION_STATUS_MAP,
  SUPPRESSING_ACTIONS, isSuppressingAction,
} from "./types.js";

function stableJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v !== undefined) out[key] = stableJsonValue(v);
    }
    return out;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function redisKeyPart(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

export function reviewFigureKey(item: Record<string, unknown>): string {
  const figureId = item.figureId ?? (item.payload as any)?.figureId ?? (item.payload as any)?.figure?.id;
  const figureSlug = item.figureSlug ?? (item.payload as any)?.figureSlug ?? (item.payload as any)?.slug ?? (item.payload as any)?.figure?.slug;
  if (figureId !== undefined && figureId !== null && String(figureId) !== "") return `id:${String(figureId)}`;
  if (figureSlug) return `slug:${String(figureSlug)}`;
  return `source:${String(item.source || "unknown")}:${String(item.sourceId || "unknown")}`;
}

export function reviewRiskKey(item: Record<string, unknown>): string {
  return String(item.riskType || (item.payload as any)?.riskType || item.type || "general_risk");
}

function usesImageEvidence(item: Record<string, unknown>): boolean {
  const riskType = reviewRiskKey(item);
  return ["image", "image_review"].includes(String(item.type || "")) || riskType.startsWith("image_");
}

function usesDetailEvidence(item: Record<string, unknown>): boolean {
  const riskType = reviewRiskKey(item);
  return item.type === "detail_review" || riskType.startsWith("detail_") || ["category_uncertain", "general_risk"].includes(riskType);
}

export function computeReviewEvidenceFingerprint(item: Record<string, unknown>): string {
  const payload = (item.payload || {}) as Record<string, unknown>;
  const includeImageEvidence = usesImageEvidence(item);
  const includeDetailEvidence = usesDetailEvidence(item);
  const currentEvidence = (item.currentStateEvidence || payload.currentStateEvidence || {}) as Record<string, unknown>;
  const currentImages = (currentEvidence.images || {}) as Record<string, unknown>;
  const currentDetail = (currentEvidence.detail || {}) as Record<string, unknown>;

  const currentImageIds = !includeImageEvidence ? [] as string[]
    : Array.isArray(currentImages.imageIds) ? (currentImages.imageIds as string[]).map(String).sort()
    : Array.isArray(payload.currentImageIds) ? (payload.currentImageIds as string[]).map(String).sort()
    : Array.isArray(payload.imageIds) ? (payload.imageIds as string[]).map(String).sort()
    : [];

  const currentImageRows = includeImageEvidence && Array.isArray(currentImages.rows)
    ? (currentImages.rows as any[]).map((row: any) => ({
        id: row.id == null ? null : String(row.id),
        source: row.source || null,
        sha256: row.sha256 || null,
        width: row.width ?? null,
        height: row.height ?? null,
        size: row.size || null,
        sortOrder: row.sortOrder ?? null,
        sourceKind: row.sourceKind || null,
        safeDisplay: row.safeDisplay === true,
        imageLowQuality: row.imageLowQuality === true,
      }))
    : [];

  const candidate = (item.candidateImage || payload.candidateImage || {}) as Record<string, unknown>;
  const detail = (item.detailSnapshot || payload.detailSnapshot || {}) as Record<string, unknown>;
  const relevantDetailFields = {
    description: currentDetail.description ?? detail.description ?? payload.description ?? null,
    scale: currentDetail.scale ?? detail.scale ?? payload.scale ?? null,
    material: currentDetail.material ?? detail.material ?? payload.material ?? null,
    priceJpy: currentDetail.priceJpy ?? detail.priceJpy ?? payload.priceJpy ?? null,
    heightMm: currentDetail.heightMm ?? detail.heightMm ?? payload.heightMm ?? null,
    weightG: currentDetail.weightG ?? detail.weightG ?? payload.weightG ?? null,
    productLine: currentDetail.productLine ?? detail.productLine ?? payload.productLine ?? null,
    ageRating: currentDetail.ageRating ?? detail.ageRating ?? payload.ageRating ?? null,
    specCount: currentDetail.specCount ?? detail.specCount ?? null,
    specs: detail.specs || null,
    categories: currentDetail.categories || detail.categories || null,
    manufacturer: currentDetail.manufacturer || detail.manufacturer || detail.manufacturerName || payload.manufacturer || null,
    series: currentDetail.series || detail.series || detail.seriesName || payload.series || null,
    releaseDate: currentDetail.releaseDate || detail.releaseDate || detail.release_date || payload.releaseDate || null,
  };

  const evidence = {
    figure: reviewFigureKey(item),
    type: item.type || "general",
    riskType: reviewRiskKey(item),
    source: item.source || null,
    sourceId: item.sourceId || null,
    primaryImageId: includeImageEvidence ? ((currentImages.primaryImageId as string) || (item.currentPublicImage as any)?.imageId || payload.primaryImageId || null) : null,
    currentImageIds,
    currentImageRows,
    candidate: {
      imageId: candidate.imageId || null,
      source: candidate.source || null,
      hash: candidate.hash || candidate.sha256 || payload.candidateAssetHash || null,
      width: candidate.width || null,
      height: candidate.height || null,
    },
    detail: includeDetailEvidence ? relevantDetailFields : null,
  };
  return crypto.createHash("sha256").update(stableJson(evidence)).digest("hex");
}

export function reviewDecisionKey(item: Record<string, unknown>): string | null {
  const fingerprint = (item.evidenceFingerprint as string) || computeReviewEvidenceFingerprint(item);
  const riskType = reviewRiskKey(item);
  const figureKey = reviewFigureKey(item);
  if (!fingerprint || !riskType || !figureKey) return null;
  return `review:decision:${redisKeyPart(figureKey)}:${redisKeyPart(String(riskType))}:${fingerprint}`;
}

export function projectReviewDecision(raw: any): ReviewDecision {
  return {
    reviewItemId: raw?.reviewItemId ?? null,
    figure: raw?.figure ?? null,
    type: raw?.type ?? null,
    riskType: raw?.riskType ?? null,
    evidenceFingerprint: raw?.evidenceFingerprint ?? null,
    action: raw?.action ?? null,
    status: raw?.status ?? null,
    reviewer: raw?.reviewer ?? null,
    decisionReason: raw?.decisionReason ?? null,
    decisionAt: raw?.decisionAt ?? null,
  };
}

export function reviewDecisionFigureMatches(decision: any, figureId?: string, figureSlug?: string, mappedFigureId?: string): boolean {
  if (!figureId && !figureSlug && !mappedFigureId) return true;
  const figure = decision?.figure;
  const figureIds = [figureId, mappedFigureId].filter((id): id is string => !!id);
  for (const id of figureIds) {
    const expected = `id:${id}`;
    if (String(figure) === expected) return true;
    if (figure && typeof figure === "object") {
      const objectId = figure.id ?? figure.figureId;
      if (objectId !== undefined && objectId !== null && String(objectId) === id) return true;
    }
  }
  if (figureSlug) {
    const expected = `slug:${figureSlug}`;
    if (String(figure) === expected) return true;
    if (figure && typeof figure === "object") {
      const objectSlug = figure.slug ?? figure.figureSlug;
      if (objectSlug !== undefined && objectSlug !== null && String(objectSlug) === figureSlug) return true;
    }
  }
  return false;
}

export function reviewDecisionMatchesQuery(decision: any, query: { riskType?: string; action?: string }, figureId?: string, figureSlug?: string, mappedFigureId?: string): boolean {
  if (query.riskType && decision?.riskType !== query.riskType) return false;
  if (query.action && decision?.action !== query.action) return false;
  return reviewDecisionFigureMatches(decision, figureId, figureSlug, mappedFigureId);
}

export class ReviewService {
  constructor(
    private repo: ReviewRepository,
    private redis: Redis,
    private prisma?: PrismaClient,
  ) {}

  async findExistingPendingReview(candidate: Record<string, unknown>): Promise<ReviewItem | null> {
    const fingerprint = (candidate.evidenceFingerprint as string) || computeReviewEvidenceFingerprint(candidate);
    const figureKey = reviewFigureKey(candidate);
    const riskType = reviewRiskKey(candidate);
    const items = await this.repo.getAllItemsRaw();
    for (const { id, raw } of items) {
      try {
        const item = JSON.parse(raw) as ReviewItem;
        if (item.status !== "pending") continue;
        const itemFingerprint = item.evidenceFingerprint || computeReviewEvidenceFingerprint(item as any);
        const itemRiskType = reviewRiskKey(item as any);
        if (itemFingerprint === fingerprint && itemRiskType === riskType && reviewFigureKey(item as any) === figureKey) {
          return item;
        }
      } catch {}
    }
    return null;
  }

  async saveReviewDecision(item: ReviewItem, action: string, reviewer: string, reason: string | null, now: string): Promise<void> {
    if (!isSuppressingAction(action)) return;
    const evidenceFingerprint = item.evidenceFingerprint || computeReviewEvidenceFingerprint(item as any);
    const decisionItem = { ...item, evidenceFingerprint };
    const key = reviewDecisionKey(decisionItem as any);
    if (!key) return;
    const decision: ReviewDecision = {
      reviewItemId: item.id,
      figure: reviewFigureKey(item as any),
      type: item.type || "general",
      riskType: reviewRiskKey(item as any),
      evidenceFingerprint,
      action,
      status: item.status,
      reviewer: reviewer || null,
      decisionReason: reason || null,
      decisionAt: now,
    };
    await this.repo.saveDecision(key, decision);
  }

  computeActionStatus(action: string): ReviewStatus {
    return ACTION_STATUS_MAP[action as ReviewAction] || "pending";
  }

  async bulkCleanup(dryRun: boolean, markStale: boolean, olderThanDays: number): Promise<BulkCleanupResult> {
    const cutoff = Date.now() - olderThanDays * 86400000;
    const ids = await this.repo.getAllItemIds();
    const updated: string[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const data = await this.repo.getItem(id);
      if (!data) continue;
      const item = data.item;
      if (item.type !== "rewrite" || item.source !== "localized-description-sync") {
        skipped.push(id);
        continue;
      }
      if (item.status !== "resolved" && item.status !== "stale") {
        skipped.push(id);
        continue;
      }
      const ts = Date.parse(item.updatedAt || item.createdAt || "");
      if (isNaN(ts) || ts > cutoff) {
        skipped.push(id);
        continue;
      }
      if (dryRun) { updated.push(id); continue; }
      if (markStale && item.status !== "stale") {
        const now = new Date().toISOString();
        item.status = "stale";
        item.notes = item.notes
          ? `${item.notes}\n[${now}] 自动清理：已 resolved 的旧 rewrite 项标记为 stale`
          : `[${now}] 自动清理：已 resolved 的旧 rewrite 项标记为 stale`;
        item.updatedAt = now;
        await this.repo.saveItem(id, item);
      }
      updated.push(id);
    }
    return {
      updatedCount: updated.length,
      skippedCount: skipped.length,
      totalScanned: ids.length,
      dryRun,
      sampleUpdated: updated.slice(0, 5),
    };
  }

  async getDecisionIfExists(item: Record<string, unknown>): Promise<ReviewDecision | null> {
    const key = reviewDecisionKey(item);
    if (!key) return null;
    const decision = await this.repo.getDecision(key);
    return decision;
  }
}
