export interface ScanResult {
  matched: number;
  deleted: number;
  failed: number;
  truncated: boolean;
}

export interface ScanKeysOptions {
  count?: number;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface RedisLike {
  scan(cursor: string, match: "MATCH", pattern: string, count: "COUNT", countVal: string): Promise<[string, string[]]>;
  unlink(...keys: string[]): Promise<number>;
}

const DEFAULT_COUNT = 200;
const DEFAULT_BATCH_SIZE = 200;

export async function scanKeys(
  redis: RedisLike,
  pattern: string,
  options?: ScanKeysOptions,
): Promise<ScanResult> {
  const count = options?.count ?? DEFAULT_COUNT;
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  let cursor = "0";
  const allKeys: string[] = [];
  const seen = new Set<string>();

  do {
    if (options?.signal?.aborted) {
      return { matched: allKeys.length, deleted: 0, failed: 0, truncated: true };
    }
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", String(count));
    cursor = nextCursor;
    for (const k of keys) {
      if (!seen.has(k)) {
        seen.add(k);
        allKeys.push(k);
      }
    }
  } while (cursor !== "0");

  if (allKeys.length === 0) return { matched: 0, deleted: 0, failed: 0, truncated: false };

  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < allKeys.length; i += batchSize) {
    if (options?.signal?.aborted) {
      return { matched: allKeys.length, deleted, failed, truncated: true };
    }
    const batch = allKeys.slice(i, i + batchSize);
    try {
      const result = await redis.unlink(...batch);
      deleted += result;
    } catch {
      failed += batch.length;
    }
  }

  return { matched: allKeys.length, deleted, failed, truncated: false };
}
