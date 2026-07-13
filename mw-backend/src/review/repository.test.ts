// Tests for the review storage repository — Phase 1+2 contract.
// Run: npx tsx --test src/review/repository.test.ts
//
// These tests cover the contract-critical pure logic (fingerprint canonicalization,
// status reconciliation, duplicate suppression) using lightweight mocks for Prisma
// and Redis. They do NOT require a live database or Redis instance.
// Storage-level (real PG/Redis) verification is a separate carry-over item that
// requires the production DB + authorization.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  ReviewRepository,
  LEGACY_STATUS_MAP,
  FingerprintMismatchError,
  type CreateReviewItemInput,
} from "./repository";

// ─── Mocks ─────────────────────────────────────────────────────────────────────

function makePrismaMock(opts: { existingActive?: any | null } = {}) {
  const existing = opts.existingActive ?? null;
  return {
    reviewItem: {
      create: async ({ data }: any) => ({ ...data, id: data.id }),
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
    $transaction: async (fn: any) => fn({
      reviewItem: {
        create: async ({ data }: any) => ({ ...data, id: data.id }),
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
    set: async (k: string, v: string, ..._rest: any[]) => { store.set(k, v); return "OK"; },
    del: async (...keys: string[]) => { let n = 0; for (const k of keys) { if (store.delete(k)) n++; } return n; },
    zadd: async (k: string, score: number, member: string) => {
      if (!zsets.has(k)) zsets.set(k, new Map());
      zsets.get(k)!.set(member, score);
      return 1;
    },
    pipeline() {
      const ops: Array<() => Promise<unknown>> = [];
      const p: any = {
        set: (k: string, v: string) => { ops.push(async () => { store.set(k, v); }); return p; },
        zadd: (k: string, score: number, member: string) => { ops.push(async () => { if (!zsets.has(k)) zsets.set(k, new Map()); zsets.get(k)!.set(member, score); }); return p; },
        exec: async () => { for (const op of ops) await op(); return []; },
      };
      return p;
    },
  } as any;
}

// ─── Fingerprint canonicalization (§8) ─────────────────────────────────────────

describe("evidenceFingerprint canonicalization (§8)", () => {
  const repo = new ReviewRepository(makePrismaMock(), makeRedisMock());

  test("image_review fingerprint is deterministic and matches canonical string", () => {
    const input: CreateReviewItemInput = {
      type: "image_review",
      figureId: 286,
      riskType: "image_low_count",
      candidateImage: { source: "amiami", url: "https://example.com/img.jpg" },
      title: "x",
    };
    const fp = repo.computeFingerprint(input);
    // Recompute expected manually
    const expected = crypto
      .createHash("sha256")
      .update("image_review|286|image_low_count|https://example.com/img.jpg")
      .digest("hex");
    assert.equal(fp, expected);
    assert.equal(fp.length, 64);
    assert.match(fp, /^[0-9a-f]{64}$/);
  });

  test("fingerprint uses figureId (not slug) when figureId present", () => {
    const withId = { type: "image_review", figureId: 286, riskType: "image_missing", candidateImage: { source: "s", url: "u" }, title: "t" } as CreateReviewItemInput;
    const withSlug = { type: "image_review", figureSlug: "reze", riskType: "image_missing", candidateImage: { source: "s", url: "u" }, title: "t" } as CreateReviewItemInput;
    const fpId = repo.computeFingerprint(withId);
    const fpSlug = repo.computeFingerprint(withSlug);
    assert.notEqual(fpId, fpSlug, "figureId and figureSlug produce different fingerprints");
    assert.ok(fpId.includes("286") === false, "fingerprint is a hash, not containing the raw id");
  });

  test("detail_review uses detailSnapshot.description", () => {
    const input: CreateReviewItemInput = {
      type: "detail_review",
      figureId: 100,
      riskType: "detail_missing_description",
      detailSnapshot: { description: "" },
      title: "x",
    };
    const fp = repo.computeFingerprint(input);
    const expected = crypto.createHash("sha256").update("detail_review|100|detail_missing_description|no-desc").digest("hex");
    assert.equal(fp, expected);
  });

  test("jan_match uses payload.janCode", () => {
    const input: CreateReviewItemInput = {
      type: "jan_match",
      figureId: 1,
      payload: { janCode: "4901234567890" },
      title: "x",
    };
    const fp = repo.computeFingerprint(input);
    const expected = crypto.createHash("sha256").update("jan_match|1|no-risk|4901234567890").digest("hex");
    assert.equal(fp, expected);
  });

  test("same inputs → same fingerprint (stability)", () => {
    const input: CreateReviewItemInput = {
      type: "image_review", figureId: 7, riskType: "image_low_count",
      candidateImage: { source: "s", url: "u" }, title: "t",
    };
    assert.equal(repo.computeFingerprint(input), repo.computeFingerprint(input));
  });
});

// ─── Status reconciliation (§2 legacy mapping) ─────────────────────────────────

describe("status reconciliation (§2)", () => {
  const repo = new ReviewRepository(makePrismaMock(), makeRedisMock());

  test("legacy approved → resolved", () => {
    assert.equal(repo.reconcileStatus("approved"), "resolved");
  });
  test("legacy stale → archived", () => {
    assert.equal(repo.reconcileStatus("stale"), "archived");
  });
  test("canonical statuses pass through", () => {
    for (const s of ["pending", "needs_changes", "resolved", "rejected", "archived"]) {
      assert.equal(repo.reconcileStatus(s), s);
    }
  });
  test("undefined → pending", () => {
    assert.equal(repo.reconcileStatus(undefined), "pending");
  });
  test("unknown → pending (defensive, no crash)", () => {
    assert.equal(repo.reconcileStatus("bogus"), "pending");
  });
  test("LEGACY_STATUS_MAP covers all legacy values", () => {
    for (const legacy of ["approved", "stale"]) {
      assert.ok(legacy in LEGACY_STATUS_MAP, `legacy ${legacy} is mapped`);
    }
  });
});

// ─── Duplicate suppression (§9) ────────────────────────────────────────────────

describe("duplicate suppression (§9)", () => {
  test("creates a new item when no active match exists", async () => {
    const repo = new ReviewRepository(makePrismaMock({ existingActive: null }), makeRedisMock());
    const result = await repo.create({
      type: "image_review", figureId: 1, riskType: "image_missing",
      candidateImage: { source: "s", url: "u" }, title: "t",
    });
    assert.equal(result.created, true);
    assert.equal(result.suppressed, false);
    assert.equal(result.reason, null);
  });

  test("suppresses with duplicate_active when a pending item with same fingerprint exists", async () => {
    const existing = {
      id: "existing-1",
      type: "image_review",
      status: "pending",
      evidenceFingerprint: "fp",
      figureId: 1n,
      createdAt: new Date(),
    };
    const repo = new ReviewRepository(makePrismaMock({ existingActive: existing }), makeRedisMock());
    const result = await repo.create({
      type: "image_review", figureId: 1, riskType: "image_missing",
      candidateImage: { source: "s", url: "u" }, title: "t",
    });
    assert.equal(result.created, false);
    assert.equal(result.suppressed, true);
    assert.equal(result.reason, "duplicate_active");
  });

  test("suppresses with duplicate_decided when a resolved item with same fingerprint exists", async () => {
    const existing = {
      id: "existing-2",
      type: "image_review",
      status: "resolved",
      evidenceFingerprint: "fp",
      figureId: 1n,
      createdAt: new Date(),
    };
    const repo = new ReviewRepository(makePrismaMock({ existingActive: existing }), makeRedisMock());
    const result = await repo.create({
      type: "image_review", figureId: 1, riskType: "image_missing",
      candidateImage: { source: "s", url: "u" }, title: "t",
    });
    assert.equal(result.created, false);
    assert.equal(result.suppressed, true);
    assert.equal(result.reason, "duplicate_decided");
  });

  test("forceReopen=true bypasses suppression and creates", async () => {
    const existing = {
      id: "existing-3",
      type: "image_review",
      status: "resolved",
      evidenceFingerprint: "fp",
      figureId: 1n,
      createdAt: new Date(),
    };
    const repo = new ReviewRepository(makePrismaMock({ existingActive: existing }), makeRedisMock());
    const result = await repo.create({
      type: "image_review", figureId: 1, riskType: "image_missing",
      candidateImage: { source: "s", url: "u" }, title: "t",
      forceReopen: true,
    });
    assert.equal(result.created, true);
    assert.equal(result.suppressed, false);
  });

  test("rejects client-supplied fingerprint that does not match canonical recompute", async () => {
    const repo = new ReviewRepository(makePrismaMock({ existingActive: null }), makeRedisMock());
    await assert.rejects(
      () => repo.create({
        type: "image_review", figureId: 1, riskType: "image_missing",
        candidateImage: { source: "s", url: "u" }, title: "t",
        evidenceFingerprint: "spoofed-fingerprint-not-matching-canonical",
      }),
      (err: unknown) => err instanceof FingerprintMismatchError,
    );
  });
});

// ─── Id generation ─────────────────────────────────────────────────────────────

describe("id generation", () => {
  const repo = new ReviewRepository(makePrismaMock(), makeRedisMock());
  test("generates unique sortable ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(repo.generateId());
    assert.equal(ids.size, 1000, "ids are unique");
  });
  test("id starts with 01 prefix (ulid-like)", () => {
    assert.ok(repo.generateId().startsWith("01"));
  });
});
