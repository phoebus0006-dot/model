// Tests for src/crawler/stateMachine.ts — Phase 1+2 crawler-state.
// Run: npx tsx --test src/crawler/stateMachine.test.ts
//
// These tests cover the state machine pure logic (transitions, legacy status
// reconciliation, canary mode enforcement) using lightweight Prisma/Redis
// mocks. They do NOT require a live database. Storage-level (real PG/Redis)
// integration tests are a carry-over item requiring the production environment.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CRAWLER_JOB_STATUSES,
  CRAWLER_JOB_TRANSITIONS,
  LEGACY_CRAWLER_STATUS_MAP,
  reconcileLegacyStatus,
  assertLegalTransition,
  isTerminalStatus,
  IllegalTransitionError,
  CrawlerJobRepository,
  type ClaimOpts,
} from "./stateMachine";

// ─── Mocks ───────────────────────────────────────────────────────────────────

function makePrismaMock(opts: {
  existing?: Record<string, any>;
} = {}): any {
  const store = { ...opts.existing };
  return {
    _store: store,
    crawlerJob: {
      async create({ data }: any) {
        store[data.id] = { ...data, createdAt: new Date(), updatedAt: new Date() };
        return store[data.id];
      },
      async findUnique({ where }: any) {
        return store[where.id] ?? null;
      },
      async update({ where, data }: any) {
        if (!store[where.id]) throw new Error("not found");
        store[where.id] = { ...store[where.id], ...data, updatedAt: new Date() };
        return store[where.id];
      },
      async findMany({ where, take, skip, orderBy, cursor }: any) {
        let rows = Object.values(store);
        if (where?.status) {
          if (Array.isArray(where.status.in)) {
            rows = rows.filter((r: any) => where.status.in.includes(r.status));
          } else {
            rows = rows.filter((r: any) => r.status === where.status);
          }
        }
        if (where?.runner) rows = rows.filter((r: any) => r.runner === where.runner);
        if (where?.source) rows = rows.filter((r: any) => r.source === where.source);
        // crude orderBy by createdAt
        rows.sort((a: any, b: any) => a.createdAt.getTime() - b.createdAt.getTime());
        if (cursor) {
          const idx = rows.findIndex((r: any) => r.id === cursor.id);
          rows = rows.slice(idx + 1);
        } else if (skip) {
          rows = rows.slice(skip);
        }
        if (take) rows = rows.slice(0, take);
        return rows;
      },
      async count({ where }: any) {
        let rows = Object.values(store);
        if (where?.status) {
          if (Array.isArray(where.status.in)) {
            rows = rows.filter((r: any) => where.status.in.includes(r.status));
          } else {
            rows = rows.filter((r: any) => r.status === where.status);
          }
        }
        return rows.length;
      },
    },
  };
}

function makeRedisMock(): any {
  const kv: Record<string, string> = {};
  const zset: Record<string, number> = {};
  return {
    _kv: kv,
    _zset: zset,
    async set(k: string, v: string) { kv[k] = v; return "OK"; },
    async get(k: string) { return kv[k] ?? null; },
    async del(...keys: string[]) { let n = 0; for (const k of keys) { if (kv[k] !== undefined) { delete kv[k]; n++; } } return n; },
    async zadd(_key: string, score: number, member: string) { zset[member] = score; return 1; },
    async zrem(_key: string, ...members: string[]) { let n = 0; for (const m of members) { if (zset[m] !== undefined) { delete zset[m]; n++; } } return n; },
    async zrevrange(_key: string, start: number, stop: number) {
      const entries = Object.entries(zset).sort((a, b) => a[1] - b[1]);
      const sliced = entries.slice(start, stop === -1 ? undefined : stop + 1);
      return sliced.map(([m]) => m);
    },
  };
}

// ─── Canonical enum tests ────────────────────────────────────────────────────

describe("CRAWLER_JOB_STATUSES", () => {
  test("contains all 7 canonical statuses", () => {
    assert.deepEqual([...CRAWLER_JOB_STATUSES], [
      "created", "queued", "claimed", "running", "completed", "failed", "deferred",
    ]);
  });
});

describe("LEGACY_CRAWLER_STATUS_MAP", () => {
  test("maps succeeded → completed", () => {
    assert.equal(LEGACY_CRAWLER_STATUS_MAP["succeeded"], "completed");
  });

  test("maps cancelled → failed", () => {
    assert.equal(LEGACY_CRAWLER_STATUS_MAP["cancelled"], "failed");
  });

  test("preserves canonical statuses", () => {
    assert.equal(LEGACY_CRAWLER_STATUS_MAP["queued"], "queued");
    assert.equal(LEGACY_CRAWLER_STATUS_MAP["claimed"], "claimed");
    assert.equal(LEGACY_CRAWLER_STATUS_MAP["running"], "running");
    assert.equal(LEGACY_CRAWLER_STATUS_MAP["failed"], "failed");
    assert.equal(LEGACY_CRAWLER_STATUS_MAP["deferred"], "deferred");
  });
});

describe("reconcileLegacyStatus", () => {
  test("maps known legacy statuses", () => {
    assert.equal(reconcileLegacyStatus("succeeded"), "completed");
    assert.equal(reconcileLegacyStatus("cancelled"), "failed");
    assert.equal(reconcileLegacyStatus("queued"), "queued");
  });

  test("fails-closed to 'created' for unknown statuses", () => {
    assert.equal(reconcileLegacyStatus("unknown"), "created");
    assert.equal(reconcileLegacyStatus("weird_status"), "created");
  });
});

// ─── Transition validation tests ─────────────────────────────────────────────

describe("CRAWLER_JOB_TRANSITIONS", () => {
  test("created → queued is legal", () => {
    assert.ok(CRAWLER_JOB_TRANSITIONS["created"].includes("queued"));
  });

  test("queued → claimed is legal", () => {
    assert.ok(CRAWLER_JOB_TRANSITIONS["queued"].includes("claimed"));
  });

  test("claimed → running is legal", () => {
    assert.ok(CRAWLER_JOB_TRANSITIONS["claimed"].includes("running"));
  });

  test("claimed → queued is legal (timeout/release)", () => {
    assert.ok(CRAWLER_JOB_TRANSITIONS["claimed"].includes("queued"));
  });

  test("running → completed/failed/deferred is legal", () => {
    assert.ok(CRAWLER_JOB_TRANSITIONS["running"].includes("completed"));
    assert.ok(CRAWLER_JOB_TRANSITIONS["running"].includes("failed"));
    assert.ok(CRAWLER_JOB_TRANSITIONS["running"].includes("deferred"));
  });

  test("deferred → queued is legal", () => {
    assert.ok(CRAWLER_JOB_TRANSITIONS["deferred"].includes("queued"));
  });

  test("failed → created is legal (admin retry)", () => {
    assert.ok(CRAWLER_JOB_TRANSITIONS["failed"].includes("created"));
  });

  test("completed is terminal (no legal targets)", () => {
    assert.deepEqual(CRAWLER_JOB_TRANSITIONS["completed"], []);
  });
});

describe("assertLegalTransition", () => {
  test("does not throw for legal transitions", () => {
    assert.doesNotThrow(() => assertLegalTransition("created", "queued"));
    assert.doesNotThrow(() => assertLegalTransition("queued", "claimed"));
    assert.doesNotThrow(() => assertLegalTransition("claimed", "running"));
    assert.doesNotThrow(() => assertLegalTransition("running", "completed"));
    assert.doesNotThrow(() => assertLegalTransition("running", "failed"));
    assert.doesNotThrow(() => assertLegalTransition("running", "deferred"));
    assert.doesNotThrow(() => assertLegalTransition("claimed", "queued"));
    assert.doesNotThrow(() => assertLegalTransition("deferred", "queued"));
    assert.doesNotThrow(() => assertLegalTransition("failed", "created"));
  });

  test("throws IllegalTransitionError for illegal transitions", () => {
    assert.throws(() => assertLegalTransition("created", "running"), IllegalTransitionError);
    assert.throws(() => assertLegalTransition("created", "completed"), IllegalTransitionError);
    assert.throws(() => assertLegalTransition("queued", "running"), IllegalTransitionError);
    assert.throws(() => assertLegalTransition("queued", "completed"), IllegalTransitionError);
    assert.throws(() => assertLegalTransition("completed", "queued"), IllegalTransitionError);
    assert.throws(() => assertLegalTransition("completed", "created"), IllegalTransitionError);
    assert.throws(() => assertLegalTransition("failed", "queued"), IllegalTransitionError);
    assert.throws(() => assertLegalTransition("failed", "running"), IllegalTransitionError);
  });

  test("accepts legacy statuses (succeeded, cancelled)", () => {
    // running → succeeded should map to running → completed (legal)
    assert.doesNotThrow(() => assertLegalTransition("running", "succeeded"));
    // running → cancelled should map to running → failed (legal)
    assert.doesNotThrow(() => assertLegalTransition("running", "cancelled"));
  });

  test("error message includes jobId when provided", () => {
    try {
      assertLegalTransition("completed", "queued", "job-123");
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.match(e.message, /job-123/);
    }
  });
});

describe("isTerminalStatus", () => {
  test("completed is terminal", () => {
    assert.equal(isTerminalStatus("completed"), true);
  });

  test("non-completed statuses are not terminal", () => {
    assert.equal(isTerminalStatus("created"), false);
    assert.equal(isTerminalStatus("queued"), false);
    assert.equal(isTerminalStatus("claimed"), false);
    assert.equal(isTerminalStatus("running"), false);
    assert.equal(isTerminalStatus("failed"), false);
    assert.equal(isTerminalStatus("deferred"), false);
  });
});

// ─── Repository tests ────────────────────────────────────────────────────────

describe("CrawlerJobRepository", () => {
  test("create() creates a job with status 'created'", async () => {
    const prisma = makePrismaMock();
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const job = await repo.create({
      id: "job-1",
      source: "amiami",
      task: "fetch_item",
    });
    assert.equal(job.status, "created");
    assert.equal(job.id, "job-1");
    // Redis ZSET should NOT be populated (job is not yet queued)
    assert.equal(redis._zset["job-1"], undefined);
  });

  test("releaseToQueued() transitions created → queued and adds to ZSET", async () => {
    const prisma = makePrismaMock();
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    await repo.create({ id: "job-1", source: "amiami", task: "fetch_item" });
    const updated = await repo.releaseToQueued("job-1");
    assert.equal(updated.status, "queued");
    assert.notEqual(redis._zset["job-1"], undefined);
    assert.notEqual(redis._kv["crawler:job:job-1"], undefined);
  });

  test("releaseToQueued() throws on non-created job", async () => {
    const prisma = makePrismaMock({
      existing: { "job-1": { id: "job-1", status: "completed", runner: "r", priority: 1, attempts: 0, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() } },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    await assert.rejects(() => repo.releaseToQueued("job-1"), IllegalTransitionError);
  });

  test("claimJobs() in canary mode requires explicit jobIds", async () => {
    const prisma = makePrismaMock();
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    await assert.rejects(
      () => repo.claimJobs({ runner: "r", workerId: "w1", canaryMode: true }),
      /Canary mode requires explicit jobIds/,
    );
  });

  test("claimJobs() in canary mode claims only allowlisted ids", async () => {
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "queued", runner: "r", priority: 1, attempts: 0, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() },
        "job-2": { id: "job-2", status: "queued", runner: "r", priority: 1, attempts: 0, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() },
        "job-3": { id: "job-3", status: "queued", runner: "r", priority: 1, attempts: 0, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const claimed = await repo.claimJobs({
      runner: "r",
      workerId: "w1",
      canaryMode: true,
      jobIds: ["job-1", "job-2"],
      limit: 10,
    });
    assert.equal(claimed.length, 2);
    const claimedIds = claimed.map((c) => c.job.id);
    assert.ok(claimedIds.includes("job-1"));
    assert.ok(claimedIds.includes("job-2"));
    assert.ok(!claimedIds.includes("job-3"));
    // Status should be "claimed" with attempts incremented
    assert.equal(claimed[0].job.status, "claimed");
    assert.equal(claimed[0].job.attempts, 1);
    assert.equal(claimed[0].job.workerId, "w1");
  });

  test("claimJobs() skips non-queued jobs", async () => {
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "running", runner: "r", priority: 1, attempts: 1, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() },
        "job-2": { id: "job-2", status: "queued", runner: "r", priority: 1, attempts: 0, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const claimed = await repo.claimJobs({
      runner: "r",
      workerId: "w1",
      jobIds: ["job-1", "job-2"],
      limit: 10,
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].job.id, "job-2");
  });

  test("claimJobs() skips jobs past maxAttempts", async () => {
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "queued", runner: "r", priority: 1, attempts: 3, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const claimed = await repo.claimJobs({
      runner: "r",
      workerId: "w1",
      jobIds: ["job-1"],
      limit: 10,
    });
    assert.equal(claimed.length, 0);
  });

  test("claimJobs() respects notBefore (deferred jobs not yet eligible)", async () => {
    const future = new Date(Date.now() + 60000);
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "deferred", runner: "r", priority: 1, attempts: 1, maxAttempts: 3, notBefore: future, createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const claimed = await repo.claimJobs({
      runner: "r",
      workerId: "w1",
      jobIds: ["job-1"],
      limit: 10,
    });
    assert.equal(claimed.length, 0);
  });

  test("start() transitions claimed → running", async () => {
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "claimed", runner: "r", priority: 1, attempts: 1, maxAttempts: 3, workerId: "w1", claimedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const updated = await repo.start("job-1");
    assert.equal(updated.status, "running");
    assert.ok(updated.runningAt);
  });

  test("complete() persists resultSummary to PG and removes from ZSET", async () => {
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "running", runner: "r", priority: 1, attempts: 1, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    redis._zset["job-1"] = 12345;
    const repo = new CrawlerJobRepository(prisma, redis);
    const updated = await repo.complete("job-1", { imagesAdded: 2, detailsUpdated: 0 });
    assert.equal(updated.status, "completed");
    assert.deepEqual(updated.resultSummary, { imagesAdded: 2, detailsUpdated: 0 });
    assert.ok(updated.completedAt);
    // ZSET entry should be removed
    assert.equal(redis._zset["job-1"], undefined);
  });

  test("fail() transitions running → failed with error message", async () => {
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "running", runner: "r", priority: 1, attempts: 1, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const updated = await repo.fail("job-1", "HTTP 429 Too Many Requests");
    assert.equal(updated.status, "failed");
    assert.equal(updated.error, "HTTP 429 Too Many Requests");
  });

  test("defer() transitions running → deferred with notBefore", async () => {
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "running", runner: "r", priority: 1, attempts: 1, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const future = new Date(Date.now() + 60000);
    const updated = await repo.defer("job-1", future, "HTTP 429");
    assert.equal(updated.status, "deferred");
    assert.deepEqual(updated.notBefore, future);
    // ZSET should be updated with notBefore timestamp as score
    assert.equal(redis._zset["job-1"], future.getTime());
  });

  test("releaseClaim() transitions claimed → queued without incrementing attempts", async () => {
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "claimed", runner: "r", priority: 1, attempts: 2, maxAttempts: 3, workerId: "w1", claimedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const updated = await repo.releaseClaim("job-1");
    assert.equal(updated.status, "queued");
    assert.equal(updated.attempts, 2); // unchanged
    assert.equal(updated.workerId, null);
    assert.equal(updated.claimedAt, null);
  });

  test("adminRetry() transitions failed → created and increments attempts", async () => {
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "failed", runner: "r", priority: 1, attempts: 1, maxAttempts: 3, error: "boom", createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const updated = await repo.adminRetry("job-1");
    assert.equal(updated.status, "created");
    assert.equal(updated.attempts, 2); // incremented
    assert.equal(updated.error, null);
    assert.equal(updated.workerId, null);
  });

  test("adminRetry() throws when maxAttempts exhausted", async () => {
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "failed", runner: "r", priority: 1, attempts: 3, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    await assert.rejects(() => repo.adminRetry("job-1"), /maxAttempts/);
  });

  test("writeback closure refreshes Redis mirror from PG", async () => {
    const prisma = makePrismaMock({
      existing: {
        "job-1": { id: "job-1", status: "queued", runner: "r", priority: 1, attempts: 0, maxAttempts: 3, createdAt: new Date(), updatedAt: new Date() },
      },
    });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const claimed = await repo.claimJobs({
      runner: "r",
      workerId: "w1",
      jobIds: ["job-1"],
      limit: 1,
    });
    assert.equal(claimed.length, 1);
    // Mutate PG directly (simulating another process)
    prisma._store["job-1"].status = "running";
    // Call writeback
    await claimed[0].writeback();
    // Redis mirror should reflect the PG state
    const mirrored = JSON.parse(redis._kv["crawler:job:job-1"]);
    assert.equal(mirrored.status, "running");
  });

  test("list() filters by status and paginates", async () => {
    const now = new Date();
    const existing: Record<string, any> = {};
    for (let i = 0; i < 5; i++) {
      existing[`job-${i}`] = {
        id: `job-${i}`,
        status: i < 2 ? "queued" : "completed",
        runner: "r",
        priority: 1,
        attempts: 0,
        maxAttempts: 3,
        createdAt: new Date(now.getTime() + i * 1000),
        updatedAt: now,
      };
    }
    const prisma = makePrismaMock({ existing });
    const redis = makeRedisMock();
    const repo = new CrawlerJobRepository(prisma, redis);
    const { jobs, total } = await repo.list({ status: "queued", limit: 10 });
    assert.equal(total, 2);
    assert.equal(jobs.length, 2);
  });
});
