import { scanKeys, ScanResult, RedisLike } from "./scan-keys.js";

export interface CacheInvalidationResult {
  matched: number;
  deleted: number;
  failed: number;
  truncated: boolean;
  namespaces: string[];
}

// Admin-facing cache namespace allowlist (matches admin.ts restrictions)
const CACHE_ALLOWLIST = [
  "figures:detail:*",
  "figures:list:*",
  "search:*",
  "homepage:*",
  "series:list:*",
  "sculptors:list:*",
  "manufacturers:list:*",
  "characters:list:*",
  "categories:*",
  "legacy:import:result:*",
];

const BLOCKED_NAMESPACE_PREFIXES = ["review:", "crawler:", "session:", "rate-limit:"];

export function isAllowedPattern(pattern: string): boolean {
  if (!pattern || typeof pattern !== "string") return false;
  for (const blocked of BLOCKED_NAMESPACE_PREFIXES) {
    if (pattern.startsWith(blocked) || pattern.includes(blocked)) return false;
  }
  for (const allowed of CACHE_ALLOWLIST) {
    const re = new RegExp("^" + allowed.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    if (re.test(pattern)) return true;
  }
  return false;
}

export function validatePatterns(patterns: string[]): string[] {
  const invalid: string[] = [];
  for (const p of patterns) {
    if (!isAllowedPattern(p)) invalid.push(p);
  }
  return invalid;
}

export class CacheService {
  constructor(private readonly redis: RedisLike) {}

  async invalidateByPattern(
    pattern: string,
    options?: { signal?: AbortSignal; count?: number },
  ): Promise<CacheInvalidationResult> {
    if (!isAllowedPattern(pattern)) {
      throw Object.assign(new Error(`Pattern not allowed: ${pattern}`), { code: "NAMESPACE_NOT_ALLOWED" });
    }

    const result: ScanResult = await scanKeys(this.redis, pattern, {
      signal: options?.signal,
      count: options?.count,
    });

    return {
      matched: result.matched,
      deleted: result.deleted,
      failed: result.failed,
      truncated: result.truncated,
      namespaces: [pattern],
    };
  }

  async invalidateByPatterns(
    patterns: string[],
    options?: { signal?: AbortSignal; count?: number },
  ): Promise<CacheInvalidationResult> {
    const invalid = validatePatterns(patterns);
    if (invalid.length > 0) {
      throw Object.assign(new Error(`Patterns not allowed: ${invalid.join(", ")}`), {
        code: "NAMESPACE_NOT_ALLOWED",
        patterns: invalid,
      });
    }

    let totalMatched = 0;
    let totalDeleted = 0;
    let totalFailed = 0;
    let truncated = false;

    for (const pattern of patterns) {
      if (options?.signal?.aborted) {
        truncated = true;
        break;
      }
      const result = await scanKeys(this.redis, pattern, {
        signal: options?.signal,
        count: options?.count,
      });
      totalMatched += result.matched;
      totalDeleted += result.deleted;
      totalFailed += result.failed;
      if (result.truncated) truncated = true;
    }

    return {
      matched: totalMatched,
      deleted: totalDeleted,
      failed: totalFailed,
      truncated,
      namespaces: patterns,
    };
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await (this.redis as any).get(key);
    if (raw === null || raw === undefined) return null;
    return JSON.parse(raw) as T;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds !== undefined) {
      await (this.redis as any).set(key, serialized, "EX", ttlSeconds);
    } else {
      await (this.redis as any).set(key, serialized);
    }
  }

  async del(key: string): Promise<boolean> {
    const result = await this.redis.unlink(key);
    return result > 0;
  }
}
