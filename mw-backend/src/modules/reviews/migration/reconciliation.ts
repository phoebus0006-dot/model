import type { ParsedReviewItem } from "./migration-types.js";

export interface ReconciliationResult {
  redisCount: number;
  pgCount: number;
  matchRate: number;
  keyMatch: number;
  keyMissingInRedis: number;
  keyMissingInPg: number;
  statusMatch: number;
  statusMismatch: Array<{ key: string; redisStatus: string; pgStatus: string }>;
  fieldDifferences: number;
  fieldDiffSamples: Array<{ key: string; field: string; redis: unknown; pg: unknown }>;
  publicIdMatch: number;
  publicIdMissingInPg: number;
  evidenceFingerprintMismatch: number;
  errors: string[];
}

export function reconcile(
  redisItems: Map<string, ParsedReviewItem>,
  pgItems: Map<string, { publicId: string; status: string; evidenceFingerprint: string | null; createdAt: Date; [key: string]: unknown }>,
): ReconciliationResult {
  const result: ReconciliationResult = {
    redisCount: redisItems.size,
    pgCount: pgItems.size,
    matchRate: 0,
    keyMatch: 0,
    keyMissingInRedis: 0,
    keyMissingInPg: 0,
    statusMatch: 0,
    statusMismatch: [],
    fieldDifferences: 0,
    fieldDiffSamples: [],
    publicIdMatch: 0,
    publicIdMissingInPg: 0,
    evidenceFingerprintMismatch: 0,
    errors: [],
  };

  let compared = 0;
  for (const [key, redisItem] of redisItems) {
    const pgItem = pgItems.get(key);
    if (!pgItem) {
      result.keyMissingInPg++;
      continue;
    }
    compared++;
    result.keyMatch++;
    if (redisItem.status === pgItem.status) {
      result.statusMatch++;
    } else {
      result.statusMismatch.push({ key, redisStatus: redisItem.status, pgStatus: pgItem.status });
    }
    if (redisItem.evidenceFingerprint !== pgItem.evidenceFingerprint) {
      result.evidenceFingerprintMismatch++;
    }
  }

  for (const key of pgItems.keys()) {
    if (!redisItems.has(key)) {
      result.keyMissingInRedis++;
    }
  }

  result.matchRate = compared > 0 ? Math.round((result.keyMatch / Math.max(redisItems.size, 1)) * 100) : 0;

  return result;
}

export const RECONCILIATION_THRESHOLDS = {
  keyMatchRate: 100,
  statusMatchRate: 100,
  maxFieldDifferences: 0,
  maxEvidenceFingerprintMismatch: 0,
  maxErrors: 0,
};
