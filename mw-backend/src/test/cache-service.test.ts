import { describe, it, expect } from "vitest";
import { scanKeys, RedisLike } from "../../src/shared/cache/scan-keys.js";
import { CacheService, isAllowedPattern, validatePatterns } from "../../src/shared/cache/cache-service.js";

function makeMockRedis(keys: Record<string, string> = {}): RedisLike {
  const store = { ...keys };
  let scanCalls = 0;
  return {
    scan: async (_cursor, _match, pattern, _count, _countVal) => {
      scanCalls++;
      const matched = Object.keys(store).filter((k) => {
        const re = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
        return re.test(k);
      });
      if (scanCalls >= 3) return ["0", matched];
      return ["1", matched];
    },
    unlink: async (...args: string[]) => {
      let count = 0;
      for (const k of args) {
        if (k in store) { delete store[k]; count++; }
      }
      return count;
    },
  };
}

describe("scanKeys", () => {
  it("returns empty result when no keys match", async () => {
    const redis = makeMockRedis({ "other:key": "1" });
    const result = await scanKeys(redis, "figures:*");
    expect(result.matched).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("scans and deletes matching keys", async () => {
    const redis = makeMockRedis({
      "figures:detail:a": "1",
      "figures:detail:b": "1",
      "figures:list:c": "1",
    });
    const result = await scanKeys(redis, "figures:detail:*");
    expect(result.matched).toBe(2);
    expect(result.deleted).toBe(2);
  });

  it("deduplicates keys across scan iterations", async () => {
    let callCount = 0;
    const redis: RedisLike = {
      scan: async () => {
        callCount++;
        if (callCount <= 2) return ["1", ["dup"]] as [string, string[]];
        return ["0", ["dup"]] as [string, string[]];
      },
      unlink: async (...args) => args.length,
    };
    const result = await scanKeys(redis, "test:*");
    expect(result.matched).toBe(1);
    expect(result.deleted).toBe(1);
  });

  it("handles abort signal", async () => {
    const controller = new AbortController();
    const redis: RedisLike = {
      scan: async () => {
        controller.abort();
        return ["1", ["a", "b"]] as [string, string[]];
      },
      unlink: async (...args) => args.length,
    };
    const result = await scanKeys(redis, "test:*", { signal: controller.signal });
    expect(result.truncated).toBe(true);
  });

  it("handles unlink failure gracefully", async () => {
    const redis = makeMockRedis({ "test:k1": "1", "test:k2": "1" });
    const failingRedis: RedisLike = {
      ...redis,
      unlink: async () => { throw new Error("fail"); },
    };
    const result = await scanKeys(failingRedis, "test:*");
    expect(result.matched).toBe(2);
    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(2);
  });
});

describe("CacheService", () => {
  it("isAllowedPattern allows known namespaces", () => {
    expect(isAllowedPattern("figures:detail:*")).toBe(true);
    expect(isAllowedPattern("figures:list:*")).toBe(true);
    expect(isAllowedPattern("series:list:*")).toBe(true);
    expect(isAllowedPattern("sculptors:list:*")).toBe(true);
    expect(isAllowedPattern("manufacturers:list:*")).toBe(true);
    expect(isAllowedPattern("characters:list:*")).toBe(true);
    expect(isAllowedPattern("categories:*")).toBe(true);
  });

  it("isAllowedPattern rejects arbitrary patterns", () => {
    expect(isAllowedPattern("user:*")).toBe(false);
    expect(isAllowedPattern("*")).toBe(false);
    expect(isAllowedPattern("session:*")).toBe(false);
    expect(isAllowedPattern("config:*")).toBe(false);
  });

  it("validatePatterns returns invalid patterns", () => {
    const invalid = validatePatterns(["figures:detail:*", "user:*", "bad:*"]);
    expect(invalid).toEqual(["user:*", "bad:*"]);
  });

  it("invalidateByPattern throws on disallowed pattern", async () => {
    const redis = makeMockRedis();
    const svc = new CacheService(redis);
    await expect(svc.invalidateByPattern("user:*")).rejects.toThrow();
  });

  it("invalidateByPattern calls scan+unlink for allowed pattern", async () => {
    const redis = makeMockRedis({ "figures:detail:test": "1" });
    const svc = new CacheService(redis);
    const result = await svc.invalidateByPattern("figures:detail:*");
    expect(result.matched).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.namespaces).toEqual(["figures:detail:*"]);
  });

  it("invalidateByPatterns aggregates multiple patterns", async () => {
    const redis = makeMockRedis({
      "figures:detail:a": "1",
      "figures:list:b": "1",
    });
    const svc = new CacheService(redis);
    const result = await svc.invalidateByPatterns(["figures:detail:*", "figures:list:*"]);
    expect(result.matched).toBe(2);
    expect(result.deleted).toBe(2);
    expect(result.namespaces).toHaveLength(2);
  });
});
