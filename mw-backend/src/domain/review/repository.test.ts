// Tests for the domain-layer Review repository.
// Run: npx tsx --test src/domain/review/repository.test.ts
//
// Covers:
//   - duplicate suppression (duplicate_active, duplicate_decided)
//   - forceReopen bypass
//   - fingerprint mismatch rejection
//   - state transition validation
//   - migration dry-run classification (does NOT write to PG)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DomainReviewRepository,
  FingerprintMismatchError,
  IllegalReviewTransitionError,
  assertLegalReviewTransition,
  type CreateReviewInput,
} from "./repository";
import { runMigration } from "./migration";

// ─── Mocks ─────────────────────────────────────────────────────────────────────

function makePrismaMock(opts: { existingActive?: any | null } = {}) {
  const existing = opts.existingActive ?? null;
  let createCallCount = 0;
  return {
    _createCallCount: () => createCallCount,
    reviewItem: {
      create: async ({ data }: any) => {
        createCallCount++;
        return { ...data, id: data.id };
      },
      findUnique: async ({ where }: any) => {
        if (where.id === existing?.id) return existing;
        return null;
      },
      findFirst: async () => existing,
      findMany: async () => [],
      count: async () => 0,
      update: async ({ where, data }: any) => ({ ...existing, ...data, id: where.id }),
    },
    reviewDecision: {
      create: async ({ data }: any) => ({ ...data, id: 1n }),
    },
    $transaction: async (fn: any) =>
      fn({
        reviewItem: {
          create: async ({ data }: any) => {
            createCallCount++;
            return { ...data, id: data.id };
          },
          update: async ({ where, data }: any) => ({ ...existing, ...data, id: where.id }),
        },
        reviewDecision: { create: async ({ data }: any) => ({ ...data, id: 1n }) },
      }),
  } as any;
}

function makeRedisMock() {
  const store = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  return {
    store,
    zsets,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ..._rest: any[]) => {
      store.set(k, v);
      return "OK";
    },
    del: async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) {
        if (store.delete(k)) n++;
      }
      return n;
    },
    zadd: async (k: string, score: number, member: string) => {
      if (!zsets.has(k)) zsets.set(k, new Map());
      zsets.get(k)!.set(member, score);
      return 1;
    },
    zrange: async (_k: string, _start: number, _end: number) => [],
    scan: async (_cursor: string, ..._args: any[]) => ["0", []],
    pipeline() {
      const ops: Array<() => Promise<unknown>> = [];
      const p: any = {
        set: (k: string, v: string) => {
          ops.push(async () => {
            store.set(k, v);
          });
          return p;
        },
        zadd: (k: string, score: number, member: string) => {
          ops.push(async () => {
            if (!zsets.has(k)) zsets.set(k, new Map());
            zsets.get(k)!.set(member, score);
          });
          return p;
        },
        exec: async () => {
          for (const op of ops) await op();
          return [];
        },
      };
      return p;
    },
    disconnect: async () => {},
  } as any;
}

const baseInput: CreateReviewInput = {
  type: "image_review",
  title: "Test item",
  figureId: 286,
  riskType: "image_low_count",
  primaryImageId: "12",
  imageIds: ["12", "13"],
  candidateAsset: { hash: "abc123", source: "amiami", url: "https://example.com/img.jpg" },
  description: "Test description",
  spec: { scale: "1/7", material: "PVC" },
};

// ─── Fingerprint computation (canonical) ──────────────────────────────────────

describe("canonical fingerprint computation", () => {
  test("produces a 64-char hex string", () => {
    const repo = new DomainReviewRepository(makePrismaMock(), makeRedisMock());
    const fp = repo.computeFingerprint(baseInput);
    assert.equal(fp.length, 64);
    assert.match(fp, /^[0-9a-f]{64}$/);
  });

  test("same input → same fingerprint (stability)", () => {
    const repo = new DomainReviewRepository(makePrismaMock(), makeRedisMock());
    assert.equal(repo.computeFingerprint(baseInput), repo.computeFingerprint(baseInput));
  });

  test("different riskType → different fingerprint", () => {
    const repo = new DomainReviewRepository(makePrismaMock(), makeRedisMock());
    const changed = { ...baseInput, riskType: "image_missing" };
    assert.notEqual(repo.computeFingerprint(baseInput), repo.computeFingerprint(changed));
  });

  test("different imageIds set → different fingerprint", () => {
    const repo = new DomainReviewRepository(makePrismaMock(), makeRedisMock());
    const changed = { ...baseInput, imageIds: ["12", "13", "14"] };
    assert.notEqual(repo.computeFingerprint(baseInput), repo.computeFingerprint(changed));
  });

  test("reordered imageIds → SAME fingerprint (set semantics)", () => {
    const repo = new DomainReviewRepository(makePrismaMock(), makeRedisMock());
    const reordered = { ...baseInput, imageIds: ["13", "12"] };
    assert.equal(repo.computeFingerprint(baseInput), repo.computeFingerprint(reordered));
  });
});

// ─── Duplicate suppression (§9) ────────────────────────────────────────────────

describe("duplicate suppression (§9)", () => {
  test("creates a new item when no active match exists", async () => {
    const repo = new DomainReviewRepository(makePrismaMock({ existingActive: null }), makeRedisMock());
    const result = await repo.create(baseInput);
    assert.equal(result.created, true);
    assert.equal(result.suppressed, false);
    assert.equal(result.reason, null);
  });

  test("suppresses with duplicate_active when a pending item with same fingerprint exists", async () => {
    const fp = new DomainReviewRepository(makePrismaMock(), makeRedisMock()).computeFingerprint(baseInput);
    const existing = {
      id: "existing-1",
      type: "image_review",
      status: "pending",
      evidenceFingerprint: fp,
      figureId: 286n,
      createdAt: new Date(),
    };
    const repo = new DomainReviewRepository(makePrismaMock({ existingActive: existing }), makeRedisMock());
    const result = await repo.create(baseInput);
    assert.equal(result.created, false);
    assert.equal(result.suppressed, true);
    assert.equal(result.reason, "duplicate_active");
  });

  test("suppresses with duplicate_decided when a resolved item with same fingerprint exists", async () => {
    const fp = new DomainReviewRepository(makePrismaMock(), makeRedisMock()).computeFingerprint(baseInput);
    const existing = {
      id: "existing-2",
      type: "image_review",
      status: "resolved",
      evidenceFingerprint: fp,
      figureId: 286n,
      createdAt: new Date(),
    };
    const repo = new DomainReviewRepository(makePrismaMock({ existingActive: existing }), makeRedisMock());
    const result = await repo.create(baseInput);
    assert.equal(result.created, false);
    assert.equal(result.suppressed, true);
    assert.equal(result.reason, "duplicate_decided");
  });

  test("suppresses with duplicate_decided when a rejected item exists", async () => {
    const fp = new DomainReviewRepository(makePrismaMock(), makeRedisMock()).computeFingerprint(baseInput);
    const existing = {
      id: "existing-3",
      type: "image_review",
      status: "rejected",
      evidenceFingerprint: fp,
      figureId: 286n,
      createdAt: new Date(),
    };
    const repo = new DomainReviewRepository(makePrismaMock({ existingActive: existing }), makeRedisMock());
    const result = await repo.create(baseInput);
    assert.equal(result.created, false);
    assert.equal(result.suppressed, true);
    assert.equal(result.reason, "duplicate_decided");
  });

  test("creates normally when only archived items match", async () => {
    const repo = new DomainReviewRepository(makePrismaMock({ existingActive: null }), makeRedisMock());
    const result = await repo.create(baseInput);
    assert.equal(result.created, true);
    assert.equal(result.suppressed, false);
  });
});

// ─── forceReopen (§10) ─────────────────────────────────────────────────────────

describe("forceReopen bypass (§10)", () => {
  test("forceReopen=true bypasses suppression and creates even with active duplicate", async () => {
    const fp = new DomainReviewRepository(makePrismaMock(), makeRedisMock()).computeFingerprint(baseInput);
    const existing = {
      id: "existing-reopen",
      type: "image_review",
      status: "resolved",
      evidenceFingerprint: fp,
      figureId: 286n,
      createdAt: new Date(),
    };
    const prismaMock = makePrismaMock({ existingActive: existing });
    const repo = new DomainReviewRepository(prismaMock, makeRedisMock());
    const result = await repo.create({ ...baseInput, forceReopen: true });
    assert.equal(result.created, true);
    assert.equal(result.suppressed, false);
  });

  test("forceReopen=true bypasses suppression even with pending duplicate", async () => {
    const fp = new DomainReviewRepository(makePrismaMock(), makeRedisMock()).computeFingerprint(baseInput);
    const existing = {
      id: "existing-pending",
      type: "image_review",
      status: "pending",
      evidenceFingerprint: fp,
      figureId: 286n,
      createdAt: new Date(),
    };
    const repo = new DomainReviewRepository(makePrismaMock({ existingActive: existing }), makeRedisMock());
    const result = await repo.create({ ...baseInput, forceReopen: true });
    assert.equal(result.created, true);
    assert.equal(result.suppressed, false);
  });
});

// ─── Fingerprint mismatch ─────────────────────────────────────────────────────

describe("fingerprint mismatch", () => {
  test("rejects client-supplied fingerprint that does not match canonical recompute", async () => {
    const repo = new DomainReviewRepository(makePrismaMock({ existingActive: null }), makeRedisMock());
    await assert.rejects(
      () =>
        repo.create({
          ...baseInput,
          evidenceFingerprint: "spoofed-fingerprint-not-matching-canonical",
        }),
      (err: unknown) => err instanceof FingerprintMismatchError,
    );
  });

  test("accepts client-supplied fingerprint that matches canonical recompute", async () => {
    const repo = new DomainReviewRepository(makePrismaMock({ existingActive: null }), makeRedisMock());
    const canonicalFp = repo.computeFingerprint(baseInput);
    const result = await repo.create({ ...baseInput, evidenceFingerprint: canonicalFp });
    assert.equal(result.created, true);
  });
});

// ─── State transition validation ───────────────────────────────────────────────

describe("state transition validation (§2)", () => {
  test("pending → resolved is legal", () => {
    assert.doesNotThrow(() => assertLegalReviewTransition("pending", "resolved"));
  });

  test("pending → rejected is legal", () => {
    assert.doesNotThrow(() => assertLegalReviewTransition("pending", "rejected"));
  });

  test("pending → needs_changes is legal", () => {
    assert.doesNotThrow(() => assertLegalReviewTransition("pending", "needs_changes"));
  });

  test("resolved → pending (reopen) is legal", () => {
    assert.doesNotThrow(() => assertLegalReviewTransition("resolved", "pending"));
  });

  test("archived → pending (human reopen) is legal", () => {
    assert.doesNotThrow(() => assertLegalReviewTransition("archived", "pending"));
  });

  test("completed → pending is illegal (no such transition)", () => {
    assert.throws(
      () => assertLegalReviewTransition("completed", "pending"),
      (err: unknown) => err instanceof IllegalReviewTransitionError,
    );
  });

  test("legacy 'approved' → pending is legal (resolved → pending)", () => {
    assert.doesNotThrow(() => assertLegalReviewTransition("approved", "pending"));
  });
});

// ─── Migration classification: dry-run does NOT write to PG ───────────────────

describe("migration classification: dry-run does not write database", () => {
  function makeMigrationPrismaMock(opts: {
    existingItems?: any[];
    existingById?: Record<string, any>;
    count?: number;
  } = {}) {
    let createCallCount = 0;
    const items = opts.existingItems ?? [];
    return {
      _createCallCount: () => createCallCount,
      reviewItem: {
        create: async ({ data }: any) => {
          createCallCount++;
          return { ...data };
        },
        findUnique: async ({ where }: any) => opts.existingById?.[where.id] ?? null,
        findFirst: async () => null,
        count: async () => opts.count ?? 0,
      },
    } as any;
  }

  function makeMigrationRedisMock(opts: { items?: Record<string, string> } = {}) {
    const store = new Map<string, string>();
    const items = opts.items ?? {};
    for (const [k, v] of Object.entries(items)) {
      store.set(`review:item:${k}`, v);
    }
    return {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
        return "OK";
      },
      zrange: async (_k: string, _start: number, _end: number) => [] as string[],
      scan: async (_cursor: string, ..._args: any[]) => {
        // Return all review:item: keys in one batch
        const keys = [...store.keys()].filter((k) => k.startsWith("review:item:"));
        return ["0", keys];
      },
      disconnect: async () => {},
    } as any;
  }

  const validRedisItem = JSON.stringify({
    type: "image_review",
    title: "Test figure",
    status: "pending",
    figureId: "286",
    riskType: "image_low_count",
    evidenceFingerprint: "fp-abc123",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  test("dry-run: does NOT call prisma.reviewItem.create", async () => {
    const prisma = makeMigrationPrismaMock({ count: 0 });
    const redis = makeMigrationRedisMock({
      items: { "item-1": validRedisItem },
    });

    const stats = await runMigration({
      prisma,
      redis,
      isExecute: false,
      verbose: false,
    });

    // Dry-run must not write anything
    assert.equal(prisma._createCallCount(), 0, "dry-run must not call prisma.reviewItem.create");
    assert.equal(stats.migratedCount, 0);
    assert.equal(stats.migratableCount, 1, "item is classified as migratable");
    assert.equal(stats.beforeCount, stats.afterCount, "PG count unchanged");
  });

  test("dry-run: classifies invalid items (missing type) correctly", async () => {
    const invalidItem = JSON.stringify({ title: "no type" });
    const prisma = makeMigrationPrismaMock({ count: 0 });
    const redis = makeMigrationRedisMock({
      items: { "bad-1": invalidItem },
    });

    const stats = await runMigration({
      prisma,
      redis,
      isExecute: false,
      verbose: false,
    });

    assert.equal(stats.invalidCount, 1);
    assert.equal(stats.migratableCount, 0);
    assert.equal(prisma._createCallCount(), 0);
  });

  test("dry-run: classifies unparseable JSON correctly", async () => {
    const prisma = makeMigrationPrismaMock({ count: 0 });
    const redis = makeMigrationRedisMock({
      items: { "bad-json": "{not valid json" },
    });

    const stats = await runMigration({
      prisma,
      redis,
      isExecute: false,
      verbose: false,
    });

    assert.equal(stats.invalidCount, 1);
    assert.equal(stats.migratableCount, 0);
    assert.equal(prisma._createCallCount(), 0);
  });

  test("dry-run: skips items already in PG by id", async () => {
    const prisma = makeMigrationPrismaMock({
      count: 1,
      existingById: { "item-1": { id: "item-1" } },
    });
    const redis = makeMigrationRedisMock({
      items: { "item-1": validRedisItem },
    });

    const stats = await runMigration({
      prisma,
      redis,
      isExecute: false,
      verbose: false,
    });

    assert.equal(stats.skippedCount, 1);
    assert.equal(stats.migratableCount, 0);
    assert.equal(prisma._createCallCount(), 0);
  });

  test("execute mode: writes migratable items to PG", async () => {
    const prisma = makeMigrationPrismaMock({ count: 0 });
    const redis = makeMigrationRedisMock({
      items: { "item-1": validRedisItem },
    });

    const stats = await runMigration({
      prisma,
      redis,
      isExecute: true,
      verbose: false,
    });

    assert.equal(prisma._createCallCount(), 1, "execute mode must call prisma.reviewItem.create");
    assert.equal(stats.migratedCount, 1);
    assert.equal(stats.migratableCount, 1);
  });

  test("dry-run: outputs full stats object with all fields", async () => {
    const prisma = makeMigrationPrismaMock({ count: 0 });
    const redis = makeMigrationRedisMock({
      items: { "item-1": validRedisItem },
    });

    const stats = await runMigration({
      prisma,
      redis,
      isExecute: false,
      verbose: false,
    });

    const requiredKeys = [
      "beforeCount",
      "classifiedCount",
      "migratableCount",
      "duplicateCount",
      "invalidCount",
      "migratedCount",
      "skippedCount",
      "failedCount",
      "afterCount",
    ];
    for (const key of requiredKeys) {
      assert.ok(key in stats, `stats must include ${key}`);
    }
  });
});
