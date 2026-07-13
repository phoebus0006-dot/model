// Tests for src/security/redisGuard.ts — Phase 1+2 runtime-security.
// Run: npx tsx --test src/security/redisGuard.test.ts
//
// These tests use a lightweight mock of the ioredis Redis interface. They do
// NOT require a live Redis instance. Storage-level (real Redis) verification
// is a separate carry-over item requiring the production environment.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  scanKeys,
  purgeByPattern,
  installRedisFlushGuard,
  DEFAULT_BLOCKED_NAMESPACES,
} from "./redisGuard";

// ─── Mock Redis ───────────────────────────────────────────────────────────────
//
// The mock implements only the methods our module touches: scan, unlink, del,
// sendCommand. Each test configures the mock with a scripted set of keys.

function makeRedisMock(opts: {
  keys?: string[]; // all keys present in the fake keyspace
  scanBatchSize?: number; // keys returned per SCAN call
  unlinkResult?: number;
} = {}): any {
  const allKeys = opts.keys ?? [];
  const batchSize = opts.scanBatchSize ?? 100;
  const unlinked: string[] = [];
  return {
    _allKeys: allKeys,
    _unlinked: unlinked,
    async scan(cursor: string, _op: string, pattern: string, _countKey: string, _countVal: string) {
      // Naive glob: only supports prefix* patterns (sufficient for our tests).
      const prefix = pattern.replace(/\*$/, "");
      const matched = allKeys.filter((k) => k.startsWith(prefix) || pattern === "*");
      // Paginate based on cursor
      const start = parseInt(cursor, 10);
      const slice = matched.slice(start, start + batchSize);
      const nextCursor = start + batchSize >= matched.length ? "0" : String(start + batchSize);
      return [nextCursor, slice];
    },
    async unlink(...keys: string[]) {
      unlinked.push(...keys);
      return opts.unlinkResult ?? keys.length;
    },
    async del(...keys: string[]) {
      unlinked.push(...keys);
      return keys.length;
    },
    // sendCommand default: no-op (overridden by flush guard tests)
    sendCommand(command: any, ..._rest: any[]) {
      return Promise.resolve(undefined);
    },
  };
}

// ─── scanKeys ────────────────────────────────────────────────────────────────

describe("scanKeys", () => {
  test("returns matching keys for a prefix pattern", async () => {
    const redis = makeRedisMock({
      keys: ["figures:detail:1", "figures:detail:2", "series:list:a", "review:item:x"],
    });
    const out = await scanKeys(redis, "figures:detail:*");
    assert.equal(out.length, 2);
    assert.ok(out.includes("figures:detail:1"));
    assert.ok(out.includes("figures:detail:2"));
  });

  test("returns empty array when nothing matches", async () => {
    const redis = makeRedisMock({ keys: ["figures:detail:1"] });
    const out = await scanKeys(redis, "sculptors:list:*");
    assert.equal(out.length, 0);
  });

  test("rejects wildcard-only pattern", async () => {
    const redis = makeRedisMock();
    await assert.rejects(() => scanKeys(redis, "*"), /wildcard-only pattern/);
    await assert.rejects(() => scanKeys(redis, "**"), /wildcard-only pattern/);
  });

  test("rejects empty pattern", async () => {
    const redis = makeRedisMock();
    await assert.rejects(() => scanKeys(redis, ""), /non-empty string/);
  });

  test("respects safety cap and throws when exceeded", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `figures:detail:${i}`);
    const redis = makeRedisMock({ keys: many });
    await assert.rejects(
      () => scanKeys(redis, "figures:detail:*", { limit: 5 }),
      /safety cap exceeded/,
    );
  });

  test("paginates across multiple SCAN rounds", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `figures:detail:${i}`);
    // Force small batches so SCAN iterates multiple times.
    const redis = makeRedisMock({ keys: many, scanBatchSize: 50 });
    const out = await scanKeys(redis, "figures:detail:*");
    assert.equal(out.length, 250);
  });
});

// ─── purgeByPattern ──────────────────────────────────────────────────────────

describe("purgeByPattern", () => {
  test("deletes matching keys via UNLINK and returns counts", async () => {
    const redis = makeRedisMock({
      keys: ["figures:detail:1", "figures:detail:2", "review:item:x"],
    });
    const res = await purgeByPattern(redis, "figures:detail:*");
    assert.equal(res.matched, 2);
    assert.equal(res.deleted, 2);
    assert.equal(res.dryRun, false);
    assert.equal(redis._unlinked.length, 2);
    assert.ok(redis._unlinked.includes("figures:detail:1"));
    assert.ok(redis._unlinked.includes("figures:detail:2"));
    // Must NOT touch review: namespace
    assert.ok(!redis._unlinked.some((k: string) => k.startsWith("review:")));
  });

  test("rejects wildcard-only pattern", async () => {
    const redis = makeRedisMock();
    await assert.rejects(() => purgeByPattern(redis, "*"), /wildcard-only pattern/);
  });

  test("rejects pattern overlapping blocked namespace", async () => {
    const redis = makeRedisMock();
    // review:* literally overlaps
    await assert.rejects(
      () => purgeByPattern(redis, "review:*"),
      /overlaps blocked namespace "review:"/,
    );
    // crawler:* too
    await assert.rejects(
      () => purgeByPattern(redis, "crawler:jobs"),
      /overlaps blocked namespace "crawler:"/,
    );
    // session:* too
    await assert.rejects(
      () => purgeByPattern(redis, "session:abc:*"),
      /overlaps blocked namespace "session:"/,
    );
  });

  test("rejects pattern that starts with a glob char", async () => {
    const redis = makeRedisMock();
    await assert.rejects(
      () => purgeByPattern(redis, "*figures*"),
      /starts with a glob char/,
    );
  });

  test("dryRun returns matched count without deleting", async () => {
    const redis = makeRedisMock({
      keys: ["figures:detail:1", "figures:detail:2"],
    });
    const res = await purgeByPattern(redis, "figures:detail:*", { dryRun: true });
    assert.equal(res.matched, 2);
    assert.equal(res.deleted, 0);
    assert.equal(res.dryRun, true);
    assert.equal(redis._unlinked.length, 0);
  });

  test("returns zero counts when nothing matches", async () => {
    const redis = makeRedisMock({ keys: ["review:item:x"] });
    const res = await purgeByPattern(redis, "figures:detail:*");
    assert.equal(res.matched, 0);
    assert.equal(res.deleted, 0);
  });

  test("DEFAULT_BLOCKED_NAMESPACES contains required namespaces", () => {
    assert.ok(DEFAULT_BLOCKED_NAMESPACES.includes("review:"));
    assert.ok(DEFAULT_BLOCKED_NAMESPACES.includes("crawler:"));
    assert.ok(DEFAULT_BLOCKED_NAMESPACES.includes("session:"));
    assert.ok(DEFAULT_BLOCKED_NAMESPACES.includes("rate-limit:"));
  });
});

// ─── installRedisFlushGuard ──────────────────────────────────────────────────

describe("installRedisFlushGuard", () => {
  function makeFlushGuardableRedis(): any {
    const sentCommands: any[] = [];
    return {
      _sentCommands: sentCommands,
      // Pretend ioredis prototype defines flushdb/flushall as methods that
      // would call sendCommand internally. We simulate the prototype methods.
      flushdb(this: any) {
        return this.sendCommand({ name: "flushdb", args: [] });
      },
      flushall(this: any) {
        return this.sendCommand({ name: "flushall", args: [] });
      },
      flushdbAsync(this: any) {
        return this.sendCommand({ name: "flushdb", args: [] });
      },
      flushallAsync(this: any) {
        return this.sendCommand({ name: "flushall", args: [] });
      },
      sendCommand(command: any) {
        sentCommands.push(command);
        return Promise.resolve("OK");
      },
    };
  }

  test("blocks direct redis.flushdb() call", () => {
    const redis = makeFlushGuardableRedis();
    installRedisFlushGuard(redis);
    assert.throws(() => redis.flushdb(), /is forbidden by/);
  });

  test("blocks direct redis.flushall() call", () => {
    const redis = makeFlushGuardableRedis();
    installRedisFlushGuard(redis);
    assert.throws(() => redis.flushall(), /is forbidden by/);
  });

  test("blocks redis.flushdbAsync() / flushallAsync()", () => {
    const redis = makeFlushGuardableRedis();
    installRedisFlushGuard(redis);
    assert.throws(() => redis.flushdbAsync(), /FLUSHDB.*forbidden/i);
    assert.throws(() => redis.flushallAsync(), /FLUSHALL.*forbidden/i);
  });

  test("blocks sendCommand({ name: 'FLUSHDB' }) directly", async () => {
    const redis = makeFlushGuardableRedis();
    installRedisFlushGuard(redis);
    // Wrap in async lambda so sync throws become rejected promises for assert.rejects
    await assert.rejects(
      async () => { await redis.sendCommand({ name: "FLUSHDB", args: [] }); },
      /FLUSHDB is forbidden/,
    );
    await assert.rejects(
      async () => { await redis.sendCommand({ name: "flushall", args: [] }); },
      /FLUSHALL is forbidden/,
    );
  });

  test("allows non-flush commands through sendCommand", async () => {
    const redis = makeFlushGuardableRedis();
    installRedisFlushGuard(redis);
    const res = await redis.sendCommand({ name: "GET", args: ["foo"] });
    assert.equal(res, "OK");
    assert.equal(redis._sentCommands.length, 1);
    assert.equal(redis._sentCommands[0].name, "GET");
  });

  test("guard is non-removable (Object.defineProperty configurable:false)", () => {
    const redis = makeFlushGuardableRedis();
    installRedisFlushGuard(redis);
    assert.throws(() => {
      delete (redis as any).flushdb;
    }, /Cannot delete property/);
  });

  test("guard blocks flush commands regardless of namespace config", () => {
    // Guard is independent of purgeByPattern namespace list
    const redis = makeFlushGuardableRedis();
    installRedisFlushGuard(redis);
    assert.throws(() => redis.flushdb(), /is forbidden by/);
  });
});
