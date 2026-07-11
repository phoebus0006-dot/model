export const KNOWN_REDIS_FORMAT_VERSIONS = [1] as const;
export type RedisFormatVersion = (typeof KNOWN_REDIS_FORMAT_VERSIONS)[number];

export interface ParsedReviewItem {
  publicId: string;
  type: string;
  title: string;
  source: string | null;
  sourceId: string | null;
  status: string;
  priority: number;
  confidence: number | null;
  figureId: bigint | null;
  figureSlug: string | null;
  riskType: string | null;
  riskReason: string | null;
  suggestedAction: string | null;
  evidenceFingerprint: string | null;
  reviewer: string | null;
  decisionReason: string | null;
  decisionAt: string | null;
  originalRedisKey: string;
  redisFormatVersion: number;
  payload: Record<string, unknown> | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParseResult {
  item: ParsedReviewItem;
  warnings: string[];
}

export interface BackfillReport {
  scanned: number;
  parsed: number;
  invalid: number;
  unknownVersion: number;
  unknownStatus: number;
  duplicatePublicId: number;
  duplicateRedisKey: number;
  missingActor: number;
  missingTimestamp: number;
  unsafeEntityId: number;
  wouldInsert: number;
  wouldSkip: number;
  wouldConflict: number;
  warnings: string[];
  errors: Array<{ key: string; message: string }>;
}

export function emptyBackfillReport(): BackfillReport {
  return {
    scanned: 0, parsed: 0, invalid: 0,
    unknownVersion: 0, unknownStatus: 0,
    duplicatePublicId: 0, duplicateRedisKey: 0,
    missingActor: 0, missingTimestamp: 0, unsafeEntityId: 0,
    wouldInsert: 0, wouldSkip: 0, wouldConflict: 0,
    warnings: [], errors: [],
  };
}
