import {
  type ParsedReviewItem, type ParseResult, type BackfillReport,
  emptyBackfillReport,
} from "./migration-types.js";

const VALID_STATUSES = new Set(["pending", "approved", "rejected", "needs_changes", "resolved", "stale"]);

function safeStr(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

function safeNum(v: unknown, def: number): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function nullableStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s || null;
}

function parseRedisId(id: string): { key: string; publicId: string } {
  const parts = id.split(":");
  return { key: id, publicId: parts[parts.length - 1] || id };
}

export function parseRedisReviewToDTO(raw: string, redisKey: string): ParseResult {
  const warnings: string[] = [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Invalid JSON in key ${redisKey}: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Non-object JSON in key ${redisKey}`);
  }
  const { publicId } = parseRedisId(redisKey);
  const status = safeStr(parsed.status || "pending");
  const type = safeStr(parsed.type || "general");
  if (!VALID_STATUSES.has(status) && status !== "unknown") {
    warnings.push(`Unknown status "${status}" for key ${redisKey} — preserving as-is`);
  }
  const priority = safeNum(parsed.priority, 1);
  const confidence = parsed.confidence != null ? Math.min(Math.max(Number(parsed.confidence), 0), 1) : null;
  let figureId: bigint | null = null;
  const rawFigureId = parsed.figureId != null ? parsed.figureId : null;
  if (rawFigureId != null) {
    const figStr = String(rawFigureId);
    if (/^-?\d+$/.test(figStr)) {
      try { figureId = BigInt(figStr); } catch { warnings.push(`Cannot parse figureId "${figStr}" as BigInt for key ${redisKey} — storing as null`); }
    } else {
      warnings.push(`Non-numeric figureId "${figStr}" for key ${redisKey} — storing as null`);
    }
  }
  let reviewer = nullableStr(parsed.reviewer);
  if (!reviewer) {
    warnings.push(`Missing actor for key ${redisKey} — using "system"`);
  }
  const createdAt = safeStr(parsed.createdAt || new Date().toISOString());
  let updatedAt = safeStr(parsed.updatedAt || "");
  if (!updatedAt) {
    updatedAt = createdAt;
    warnings.push(`Missing updatedAt for key ${redisKey} — falling back to createdAt`);
  }
  const item: ParsedReviewItem = {
    publicId,
    type,
    title: safeStr(parsed.title || ""),
    source: nullableStr(parsed.source),
    sourceId: nullableStr(parsed.sourceId),
    status,
    priority,
    confidence: confidence != null ? confidence : null,
    figureId,
    figureSlug: nullableStr(parsed.figureSlug),
    riskType: nullableStr(parsed.riskType),
    riskReason: nullableStr(parsed.riskReason),
    suggestedAction: nullableStr(parsed.suggestedAction),
    evidenceFingerprint: nullableStr(parsed.evidenceFingerprint),
    reviewer: reviewer || "system",
    decisionReason: nullableStr(parsed.decisionReason),
    decisionAt: nullableStr(parsed.decisionAt),
    originalRedisKey: redisKey,
    redisFormatVersion: 1,
    payload: parsed.payload || parsed.candidateImage || parsed.detailSnapshot ? { candidateImage: parsed.candidateImage, detailSnapshot: parsed.detailSnapshot, currentPublicImage: parsed.currentPublicImage, automation: parsed.automation, payload: parsed.payload } : null,
    notes: nullableStr(parsed.notes),
    createdAt,
    updatedAt,
  };
  return { item, warnings };
}

export function parseRedisDecisionToEvent(raw: string, redisKey: string): { reviewItemId: string; event: string; action: string; status: string; actor: string; reason: string | null; createdAt: string } | null {
  try {
    const parsed = JSON.parse(raw);
    return {
      reviewItemId: safeStr(parsed.reviewItemId),
      event: "suppression",
      action: safeStr(parsed.action),
      status: safeStr(parsed.status),
      actor: safeStr(parsed.reviewer || "system"),
      reason: nullableStr(parsed.decisionReason),
      createdAt: safeStr(parsed.decisionAt || new Date().toISOString()),
    };
  } catch {
    return null;
  }
}
