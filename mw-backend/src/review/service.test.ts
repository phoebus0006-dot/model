// Tests for the review service layer — Phase 1+2 contract.
// Run: npx tsx --test src/review/service.test.ts
//
// These tests cover the integration-layer logic (ACTION→status mapping,
// currentStateSnapshot computation, recheck, applyAction idempotency)
// using lightweight mocks for Prisma and Redis. They do NOT require a live
// database or Redis instance. Storage-level (real PG/Redis) verification is
// a carry-over item requiring the production DB + authorization.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ReviewService,
  ACTION_TO_STATUS,
} from "./service";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";

// ─── Mocks ───────────────────────────────────────────────────────────────────

function makeFigureRow(overrides: any = {}) {
  return {
    id: 100n,
    slug: "test-fig",
    name: "Test Figure",
    description: "A test figure description long enough to pass checks.",
    scale: "1/7",
    material: "PVC",
    priceJpy: 12000n,
    releaseDate: new Date("2026-01-01"),
    heightMm: 250,
    weightG: 400,
    productLine: "Standard",
    ageRating: "15+",
    manufacturer: { name: "Good Smile" },
    series: { name: "Test Series" },
    janCode: "4567890123456",
    ...overrides,
  };
}

function makeImageRow(overrides: any = {}) {
  return {
    id: 1n,
    source: "https://example.com/img.jpg",
    size: "detail",
    width: 800,
    height: 800,
    sortOrder: 0,
    data: { source_kind: "trusted_retailer_image", image_low_quality: false },
    ...overrides,
  };
}

interface PrismaMockOpts {
  figure?: any | null;
  images?: any[];
  revision?: any | null;
  existingReviewItem?: any | null;
  createdReviewItems?: any[];
  createdCrawlerJobs?: any[];
  createdDecisions?: any[];
}

function makePrismaMock(opts: PrismaMockOpts = {}) {
  const figure = opts.figure !== undefined ? opts.figure : makeFigureRow();
  const images = opts.images ?? [makeImageRow()];
  const revision = opts.revision ?? null;
  const existingReviewItem = opts.existingReviewItem ?? null;
  const createdReviewItems: any[] = opts.createdReviewItems ?? [];
  const createdCrawlerJobs: any[] = opts.createdCrawlerJobs ?? [];
  const createdDecisions: any[] = opts.createdDecisions ?? [];

  return {
    _state: { createdReviewItems, createdCrawlerJobs, createdDecisions },
    reviewItem: {
      create: async ({ data }: any) => {
        const row = { ...data, id: data.id };
        createdReviewItems.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => {
        if (where.id === existingReviewItem?.id) return existingReviewItem;
        return null;
      },
      findFirst: async () => existingReviewItem,
      findMany: async () => [],
      count: async () => 0,
      update: async ({ where, data }: any) => ({ ...existingReviewItem, ...data, id: where.id }),
    },
    reviewDecision: {
      create: async ({ data }: any) => {
        const row = { ...data, id: 1n, createdAt: new Date() };
        createdDecisions.push(row);
        return row;
      },
    },
    crawlerJob: {
      create: async ({ data }: any) => {
        const row = { ...data, id: data.id };
        createdCrawlerJobs.push(row);
        return row;
      },
      findUnique: async () => null,
      findMany: async () => [],
      count: async () => 0,
      update: async ({ where, data }: any) => ({ ...where, ...data }),
    },
    figure: {
      findFirst: async () => figure,
      findUnique: async () => figure,
    },
    figureImage: {
      findMany: async () => images,
    },
    revision: {
      findFirst: async () => revision,
    },
    $transaction: async (fn: any) => fn({
      reviewItem: {
        create: async ({ data }: any) => { const r = { ...data }; createdReviewItems.push(r); return r; },
        update: async ({ where, data }: any) => ({ ...existingReviewItem, ...data, id: where.id }),
      },
      reviewDecision: {
        create: async ({ data }: any) => { const r = { ...data, id: 1n, createdAt: new Date() }; createdDecisions.push(r); return r; },
      },
    }),
  } as unknown as PrismaClient;
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
    unlink: async (...keys: string[]) => { let n = 0; for (const k of keys) { if (store.delete(k)) n++; } return n; },
    zadd: async (k: string, score: number, member: string) => {
      if (!zsets.has(k)) zsets.set(k, new Map());
      zsets.get(k)!.set(member, score);
      return 1;
    },
    zrevrange: async (_k: string, _start: number, _stop: number) => [],
    pipeline() {
      const ops: Array<() => Promise<unknown>> = [];
      const p: any = {
        set: (k: string, v: string) => { ops.push(async () => { store.set(k, v); }); return p; },
        zadd: (k: string, score: number, member: string) => {
          ops.push(async () => { if (!zsets.has(k)) zsets.set(k, new Map()); zsets.get(k)!.set(member, score); });
          return p;
        },
        exec: async () => { for (const op of ops) await op(); return []; },
      };
      return p;
    },
  } as unknown as Redis;
}

// ─── ACTION_TO_STATUS mapping (contract §4) ──────────────────────────────────

describe("ACTION_TO_STATUS mapping (contract §4)", () => {
  test("approve_image → resolved", () => {
    assert.equal(ACTION_TO_STATUS.approve_image, "resolved");
  });
  test("reject_image → rejected", () => {
    assert.equal(ACTION_TO_STATUS.reject_image, "rejected");
  });
  test("keep_placeholder → resolved", () => {
    assert.equal(ACTION_TO_STATUS.keep_placeholder, "resolved");
  });
  test("mark_detail_ok → resolved", () => {
    assert.equal(ACTION_TO_STATUS.mark_detail_ok, "resolved");
  });
  test("mark_needs_manual_edit → needs_changes", () => {
    assert.equal(ACTION_TO_STATUS.mark_needs_manual_edit, "needs_changes");
  });
  test("request_refetch → needs_changes", () => {
    assert.equal(ACTION_TO_STATUS.request_refetch, "needs_changes");
  });
  test("keep_pending → pending", () => {
    assert.equal(ACTION_TO_STATUS.keep_pending, "pending");
  });
  test("dismiss_stale → archived", () => {
    assert.equal(ACTION_TO_STATUS.dismiss_stale, "archived");
  });
  test("all 8 actions are covered", () => {
    assert.equal(Object.keys(ACTION_TO_STATUS).length, 8);
  });
});

// ─── computeCurrentStateSnapshot ─────────────────────────────────────────────

describe("computeCurrentStateSnapshot", () => {
  test("returns empty snapshot when figureId and slug are both null", async () => {
    const svc = new ReviewService(makePrismaMock(), makeRedisMock());
    const snap = await svc.computeCurrentStateSnapshot(null, null);
    assert.equal(snap.figureId, null);
    assert.equal(snap.figureName, null);
    assert.equal(snap.imageCount, 0);
    assert.equal(snap.missingFields.length, 0);
  });

  test("computes snapshot with images and specs", async () => {
    const svc = new ReviewService(makePrismaMock(), makeRedisMock());
    const snap = await svc.computeCurrentStateSnapshot(100n, "test-fig");
    assert.equal(snap.figureId, "100");
    assert.equal(snap.figureSlug, "test-fig");
    assert.equal(snap.figureName, "Test Figure");
    assert.equal(snap.imageCount, 1);
    assert.equal(snap.primaryImageId, "1");
    assert.equal(snap.primaryImageWidth, 800);
    assert.equal(snap.primaryImageHeight, 800);
    assert.equal(snap.descriptionLength > 0, true);
    assert.equal(snap.validSpecCount, 10);
    assert.equal(snap.missingFields.length, 0);
  });

  test("reports missingFields when specs are absent", async () => {
    const prisma = makePrismaMock({
      figure: makeFigureRow({
        description: "", scale: null, material: null, priceJpy: null,
        releaseDate: null, heightMm: null, weightG: null,
        productLine: null, ageRating: null,
        manufacturer: { name: "" }, series: { name: "" },
      }),
      images: [],
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const snap = await svc.computeCurrentStateSnapshot(100n);
    assert.equal(snap.imageCount, 0);
    assert.equal(snap.missingFields.includes("description"), true);
    assert.equal(snap.missingFields.includes("scale"), true);
    assert.equal(snap.missingFields.includes("manufacturer"), true);
    assert.equal(snap.missingFields.includes("series"), true);
    assert.equal(snap.validSpecCount, 0);
  });

  test("selects detail-size image as primary", async () => {
    const prisma = makePrismaMock({
      images: [
        makeImageRow({ id: 5n, size: "thumb", width: 100, height: 100, sortOrder: 0 }),
        makeImageRow({ id: 9n, size: "detail", width: 900, height: 900, sortOrder: 1 }),
      ],
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const snap = await svc.computeCurrentStateSnapshot(100n);
    assert.equal(snap.primaryImageId, "9");
    assert.equal(snap.primaryImageWidth, 900);
  });

  test("falls back to first image when no detail-size present", async () => {
    const prisma = makePrismaMock({
      images: [makeImageRow({ id: 3n, size: "thumb", width: 100, height: 100, sortOrder: 0 })],
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const snap = await svc.computeCurrentStateSnapshot(100n);
    assert.equal(snap.primaryImageId, "3");
  });
});

// ─── enrichItem ──────────────────────────────────────────────────────────────

describe("enrichItem", () => {
  test("adds currentStateSnapshot and originalEvidence fields", async () => {
    const svc = new ReviewService(makePrismaMock(), makeRedisMock());
    const item = {
      id: "r1",
      type: "image_review",
      figureId: "100",
      figureSlug: "test-fig",
      payload: { issue: "low_resolution", janCode: "4567890123456" },
    };
    const enriched = await svc.enrichItem(item);
    assert.equal((enriched as any).currentStateSnapshot.figureId, "100");
    assert.equal((enriched as any).originalEvidence.issue, "low_resolution");
    // original item fields preserved
    assert.equal((enriched as any).id, "r1");
    assert.equal((enriched as any).type, "image_review");
  });

  test("originalEvidence is null when payload absent", async () => {
    const svc = new ReviewService(makePrismaMock(), makeRedisMock());
    const item = { id: "r2", type: "general" };
    const enriched = await svc.enrichItem(item);
    assert.equal((enriched as any).originalEvidence, null);
  });

  test("payload is preserved untouched alongside snapshot", async () => {
    const svc = new ReviewService(makePrismaMock(), makeRedisMock());
    const payload = { janCode: "4567890123456", originalWidth: 256 };
    const item = { id: "r3", type: "image_review", figureId: "100", payload };
    const enriched = await svc.enrichItem(item);
    assert.deepEqual((enriched as any).payload, payload);
    assert.deepEqual((enriched as any).originalEvidence, payload);
  });
});

describe("enrichItems", () => {
  test("enriches all items in batch", async () => {
    const svc = new ReviewService(makePrismaMock(), makeRedisMock());
    const items = [
      { id: "a", type: "image_review", figureId: "100" },
      { id: "b", type: "detail_review", figureId: "100" },
    ];
    const enriched = await svc.enrichItems(items);
    assert.equal(enriched.length, 2);
    assert.equal((enriched[0] as any).currentStateSnapshot.figureId, "100");
    assert.equal((enriched[1] as any).currentStateSnapshot.figureId, "100");
  });

  test("empty list returns empty", async () => {
    const svc = new ReviewService(makePrismaMock(), makeRedisMock());
    const enriched = await svc.enrichItems([]);
    assert.equal(enriched.length, 0);
  });
});

// ─── recheckItem ─────────────────────────────────────────────────────────────

describe("recheckItem", () => {
  test("returns OK when figure is healthy", async () => {
    const svc = new ReviewService(makePrismaMock(), makeRedisMock());
    const r = await svc.recheckItem({
      id: "r1", type: "image_review", figureId: "100", riskType: "image_low_count",
    });
    assert.equal(r.stillProblem, false);
    assert.equal(r.eligibleResolve, true);
    assert.equal(r.reason, "OK");
    assert.equal(r.problems.length, 0);
  });

  test("reports FIGURE_NOT_FOUND when figure missing and type requires figure", async () => {
    const prisma = makePrismaMock({ figure: null });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r2", type: "image_review", figureId: "999",
    });
    assert.equal(r.stillProblem, true);
    assert.equal(r.eligibleResolve, false);
    assert.equal(r.problems.includes("FIGURE_NOT_FOUND"), true);
  });

  test("image_review with no images reports problem", async () => {
    const prisma = makePrismaMock({ images: [] });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r3", type: "image_review", figureId: "100", riskType: "image_missing",
    });
    assert.equal(r.stillProblem, true);
    assert.equal(r.problems.includes("仍然没有图片"), true);
  });

  test("image_review image_low_count: missing approved image reports problem", async () => {
    const prisma = makePrismaMock({
      images: [makeImageRow({ data: { source_kind: "thumbnail_only", image_low_quality: true } })],
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r4", type: "image_review", figureId: "100", riskType: "image_low_count",
    });
    assert.equal(r.stillProblem, true);
    assert.equal(r.problems.some((p) => p.includes("mfc_review_approved")), true);
  });

  test("image_review image_low_count: low-res approved image reports problem", async () => {
    const prisma = makePrismaMock({
      images: [makeImageRow({ width: 200, height: 200, data: { source_kind: "mfc_review_approved", image_low_quality: false } })],
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r5", type: "image_review", figureId: "100", riskType: "image_low_count",
    });
    assert.equal(r.stillProblem, true);
    assert.equal(r.problems.some((p) => p.includes("500x500")), true);
  });

  test("image_review image_low_count: image_low_quality=true approved reports problem", async () => {
    const prisma = makePrismaMock({
      images: [makeImageRow({
        width: 800, height: 800,
        data: { source_kind: "mfc_review_approved", image_low_quality: true },
      })],
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r6", type: "image_review", figureId: "100", riskType: "image_low_count",
    });
    assert.equal(r.stillProblem, true);
    assert.equal(r.problems.some((p) => p.includes("image_low_quality=true")), true);
  });

  test("detail_review detail_missing_description: short desc reports problem", async () => {
    const prisma = makePrismaMock({
      figure: makeFigureRow({ description: "short" }),
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r7", type: "detail_review", figureId: "100", riskType: "detail_missing_description",
    });
    assert.equal(r.stillProblem, true);
    assert.equal(r.problems.some((p) => p.includes("描述仅")), true);
  });

  test("detail_review detail_sparse_specs: too few specs reports problem", async () => {
    const prisma = makePrismaMock({
      figure: makeFigureRow({
        scale: null, material: null, priceJpy: null,
        releaseDate: null, heightMm: null, weightG: null,
        productLine: null, ageRating: null,
        manufacturer: { name: "X" }, series: { name: "Y" },
      }),
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r8", type: "detail_review", figureId: "100", riskType: "detail_sparse_specs",
    });
    assert.equal(r.stillProblem, true);
    assert.equal(r.problems.some((p) => p.includes("有效规格字段")), true);
  });

  test("rewrite: empty active revision reports problem", async () => {
    const prisma = makePrismaMock({ revision: null });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r9", type: "rewrite", figureId: "100",
    });
    assert.equal(r.stillProblem, true);
    assert.equal(r.problems.some((p) => p.includes("洗稿正文")), true);
  });

  test("rewrite: short active revision reports problem", async () => {
    const prisma = makePrismaMock({
      revision: { id: 1n, contentMd: "too short" },
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r10", type: "rewrite", figureId: "100",
    });
    assert.equal(r.stillProblem, true);
  });

  test("jan_match: mismatched JAN reports problem", async () => {
    const prisma = makePrismaMock({
      figure: makeFigureRow({ janCode: "9999999999999" }),
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r11", type: "jan_match", figureId: "100",
      payload: { janCode: "1111111111111" },
    });
    assert.equal(r.stillProblem, true);
    assert.equal(r.problems.some((p) => p.includes("JAN")), true);
  });

  test("jan_match: matching JAN is OK", async () => {
    const prisma = makePrismaMock({
      figure: makeFigureRow({ janCode: "4567890123456" }),
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r12", type: "jan_match", figureId: "100",
      payload: { janCode: "4567890123456" },
    });
    assert.equal(r.stillProblem, false);
  });

  test("image type: duplicate source+size groups reported", async () => {
    const prisma = makePrismaMock({
      images: [
        makeImageRow({ id: 1n, source: "same", size: "detail" }),
        makeImageRow({ id: 2n, source: "same", size: "detail" }),
      ],
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const r = await svc.recheckItem({
      id: "r13", type: "image", figureId: "100",
    });
    assert.equal(r.stillProblem, true);
    assert.equal(r.problems.some((p) => p.includes("重复图片记录")), true);
  });
});

// ─── applyAction ─────────────────────────────────────────────────────────────

describe("applyAction", () => {
  test("approve_image records decision with status=resolved", async () => {
    const prisma = makePrismaMock({
      existingReviewItem: {
        id: "rv1", type: "image_review", figureId: 100n, status: "pending",
        payload: {}, evidenceFingerprint: "fp1",
      },
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const result = await svc.applyAction({
      reviewItemId: "rv1",
      action: "approve_image",
      reviewerId: 5n,
      reviewerRole: "admin",
      decisionReason: "looks good",
    });
    assert.equal(result.crawlerJobId, undefined);
    assert.equal((result.decision as any).action, "approve_image");
    const state = (prisma as any)._state;
    assert.equal(state.createdCrawlerJobs.length, 0);
    assert.equal(state.createdDecisions.length, 1);
  });

  test("request_refetch creates exactly one CrawlerJob in created state", async () => {
    const prisma = makePrismaMock({
      existingReviewItem: {
        id: "rv2", type: "image_review", figureId: 100n, status: "pending",
        payload: {}, evidenceFingerprint: "fp2",
      },
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const result = await svc.applyAction({
      reviewItemId: "rv2",
      action: "request_refetch",
      reviewerId: 5n,
      reviewerRole: "admin",
      decisionReason: "need re-scrape",
    });
    assert.ok(result.crawlerJobId);
    const state = (prisma as any)._state;
    assert.equal(state.createdCrawlerJobs.length, 1);
    assert.equal(state.createdCrawlerJobs[0].status, "created");
    assert.equal(state.createdCrawlerJobs[0].linkedReviewItemId, "rv2");
  });

  test("request_refetch is idempotent — reuses existing crawlerJobId from payload", async () => {
    const prisma = makePrismaMock({
      existingReviewItem: {
        id: "rv3", type: "image_review", figureId: 100n, status: "needs_changes",
        payload: { crawlerJobId: "existing-job-001" },
        evidenceFingerprint: "fp3",
      },
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const result = await svc.applyAction({
      reviewItemId: "rv3",
      action: "request_refetch",
    });
    assert.equal(result.crawlerJobId, "existing-job-001");
    const state = (prisma as any)._state;
    // No new CrawlerJob created because one already exists
    assert.equal(state.createdCrawlerJobs.length, 0);
  });

  test("reject_image records decision with status=rejected", async () => {
    const prisma = makePrismaMock({
      existingReviewItem: {
        id: "rv4", type: "image_review", figureId: 100n, status: "pending",
        payload: {}, evidenceFingerprint: "fp4",
      },
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const result = await svc.applyAction({
      reviewItemId: "rv4",
      action: "reject_image",
      decisionReason: "wrong subject",
    });
    assert.equal((result.decision as any).action, "reject_image");
  });

  test("keep_pending does not create crawler job", async () => {
    const prisma = makePrismaMock({
      existingReviewItem: {
        id: "rv5", type: "image_review", figureId: 100n, status: "pending",
        payload: {}, evidenceFingerprint: "fp5",
      },
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const result = await svc.applyAction({
      reviewItemId: "rv5",
      action: "keep_pending",
    });
    assert.equal(result.crawlerJobId, undefined);
    const state = (prisma as any)._state;
    assert.equal(state.createdCrawlerJobs.length, 0);
  });

  test("candidateImage sha256 is recorded in decision metadata", async () => {
    const prisma = makePrismaMock({
      existingReviewItem: {
        id: "rv6", type: "image_review", figureId: 100n, status: "pending",
        payload: {}, evidenceFingerprint: "fp6",
      },
    });
    const svc = new ReviewService(prisma, makeRedisMock());
    const result = await svc.applyAction({
      reviewItemId: "rv6",
      action: "approve_image",
      candidateImage: {
        source: "https://example.com/c.jpg",
        imageId: "img-99",
        width: 1024,
        height: 1024,
        sha256: "abc123",
      },
    });
    const state = (prisma as any)._state;
    assert.equal(state.createdDecisions[0].candidateImageHash, "abc123");
    assert.deepEqual(state.createdDecisions[0].metadata, {
      candidateSource: "https://example.com/c.jpg",
      candidateImageId: "img-99",
      candidateWidth: 1024,
      candidateHeight: 1024,
    });
  });

  test("throws when review item not found", async () => {
    const prisma = makePrismaMock({ existingReviewItem: null });
    const svc = new ReviewService(prisma, makeRedisMock());
    await assert.rejects(
      () => svc.applyAction({ reviewItemId: "nonexistent", action: "approve_image" }),
      /ReviewItem not found/,
    );
  });
});

// ─── listEnriched ────────────────────────────────────────────────────────────

describe("listEnriched", () => {
  test("returns enriched items with pagination metadata", async () => {
    // Use a prisma mock that returns one review item from findMany
    const prismaMock = makePrismaMock();
    (prismaMock as any).reviewItem.findMany = async () => [{
      id: "l1",
      type: "image_review",
      figureId: 100n,
      figureSlug: "test-fig",
      status: "pending",
      payload: { issue: "low_res" },
    }];
    (prismaMock as any).reviewItem.count = async () => 1;
    const svc = new ReviewService(prismaMock, makeRedisMock());
    const result = await svc.listEnriched({ status: "pending", limit: 10, page: 1 });
    assert.equal(result.total, 1);
    assert.equal(result.page, 1);
    assert.equal(result.limit, 10);
    assert.equal(result.items.length, 1);
    assert.equal((result.items[0] as any).currentStateSnapshot.figureId, "100");
    assert.equal((result.items[0] as any).originalEvidence.issue, "low_res");
  });
});
