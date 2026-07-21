/**
 * ModelWiki Unified Redis Cache Helper with Timeout & Degradation.
 * Contract:
 *  - Cache read failure/timeout -> Log warn, fallback to PostgreSQL, return 200 OK.
 *  - Cache write failure -> Log warn, non-blocking.
 *  - Configured with strict timeouts (connectTimeout 3000ms, commandTimeout 500ms, maxRetriesPerRequest 1).
 */

export interface CacheOptions {
  connectTimeout?: number;
  commandTimeout?: number;
  maxRetriesPerRequest?: number;
  enableOfflineQueue?: boolean;
}

export const DEFAULT_REDIS_OPTIONS: CacheOptions = {
  connectTimeout: 3000,
  commandTimeout: 500,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
};

export async function safeCacheGet<T = any>(
  redis: any,
  key: string,
  logger?: any
): Promise<T | null> {
  if (!redis) return null;
  try {
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), DEFAULT_REDIS_OPTIONS.commandTimeout)
    );
    const getPromise = (async () => {
      const raw = await redis.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })();

    const result = await Promise.race([getPromise, timeoutPromise]);
    return result;
  } catch (err: any) {
    if (logger?.warn) {
      logger.warn({ key, err: err?.message || err }, "[REDIS_FALLBACK] Cache read failed/timed out, falling back to DB");
    } else {
      console.warn(`[REDIS_FALLBACK] Cache read failed/timed out for key ${key}:`, err?.message || err);
    }
    return null;
  }
}

export async function safeCacheSet(
  redis: any,
  key: string,
  data: any,
  ttlSeconds = 300,
  logger?: any
): Promise<void> {
  if (!redis) return;
  // Non-blocking write
  Promise.resolve().then(async () => {
    try {
      const serialized = JSON.stringify(data);
      await redis.set(key, serialized, "EX", ttlSeconds);
    } catch (err: any) {
      if (logger?.warn) {
        logger.warn({ key, err: err?.message || err }, "[REDIS_WARN] Cache write failed");
      } else {
        console.warn(`[REDIS_WARN] Cache write failed for key ${key}:`, err?.message || err);
      }
    }
  });
}
