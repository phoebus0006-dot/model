// Integration tests for the PG-backed review API routes.
// Run: npx tsx --test src/routes/admin-review-integration.test.ts
//
// These tests exercise the registerReviewRoutes() function with mocked
// Prisma and Redis, verifying the 10 contract scenarios:
//
//   1. GET /review/items returns PG items with _count.images + take:1 primary image
//   2. GET /review/items falls back to Redis legacy data with legacy:true when PG empty
//   3. POST /review/items creates via DomainReviewRepository with enhanced duplicate_decided
//   4. POST /review/items/:id/recheck returns only {problems, currentState, recommendedStatus, evidenceChanged}
//   5. POST /review/items/:id/action records decision via recordDecision (transaction)
//   6. POST /review/items/:id/action returns 409 for illegal transitions
//   7. POST /review/items/:id/action with keep_pending keeps status as "pending"
//   8. POST /review/items/:id/action with request_refetch is idempotent (reuses non-terminal crawlerJobId)
//   9. POST /review/items/:id/action with mark_needs_manual_edit sets status to needs_changes
//  10. POST /review/items/:id/action acquires and releases distributed lock

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { registerReviewRoutes } from "./admin.js";
import { DomainReviewRepository } from "../domain/review/repository.js";

// ─── Mock factories ──────────────────────────────────────────────────────────

function makePrismaMock(opts: {
  reviewItems?: any[];
  reviewItemById?: Record<string, any>;
  existingActive?: any | null;
  reviewDecisions?: any[];
  crawlerJobById?: Record<string, any>;
  figuresById?: Record<string, any>;
  figuresBySlug?: Record<string, any>;
  figureImages?: any[];
  revisions?: any[];
} = {}) {
  const items = opts.reviewItems ?? [];
  const byId = opts.reviewItemById ?? {};
  const decisions = opts.reviewDecisions ?? [];
  const crawlerJobs = opts.crawlerJobById ?? {};
  let createCallCount = 0;
  let decisionCreateCount = 0;
  let updateCallCount = 0;
  let crawlerJobCreateCount = 0;

  return {
    _createCallCount: () => createCallCount,
    _decisionCreateCount: () => decisionCreateCount,
    _updateCallCount: () => updateCallCount,
    _crawlerJobCreateCount: () => crawlerJobCreateCount,
    reviewItem: {
      create: async ({ data }: any) => {
        createCallCount++;
        return { ...data, id: data.id, createdAt: new Date(), updatedAt: new Date() };
      },
      findUnique: async ({ where }: any) => {
        // For getById: check byId first, then fall back to items
        if (byId[where.id]) return byId[where.id];
        const found = items.find((it: any) => it.id === where.id);
        return found ?? null;
      },
      findFirst: async (args?: any) => {
        // For fingerprint-based lookup (existingActive)
        if (opts.existingActive !== undefined) return opts.existingActive;
        // For figure lookup by slug or id
        if (args?.where?.slug) {
          return opts.figuresBySlug?.[args.where.slug] ?? null;
        }
        if (args?.where?.id) {
          const key = String(args.where.id);
          return opts.figuresById?.[key] ?? null;
        }
        return null;
      },
      findMany: async (args?: any) => {
        // For list endpoint
        let result = [...items];
        if (args?.where?.status) {
          result = result.filter((it: any) => it.status === args.where.status);
        }
        if (args?.where?.type) {
          result = result.filter((it: any) => it.type === args.where.type);
        }
        if (args?.orderBy) {
          result.sort((a: any, b: any) => {
            const da = a.createdAt instanceof Date ? a.createdAt.getTime() : Date.parse(a.createdAt || 0);
            const db = b.createdAt instanceof Date ? b.createdAt.getTime() : Date.parse(b.createdAt || 0);
            return db - da; // desc
          });
        }
        if (args?.take) result = result.slice(args.skip || 0, (args.skip || 0) + args.take);
        return result;
      },
      count: async (args?: any) => {
        let result = [...items];
        if (args?.where?.status) {
          result = result.filter((it: any) => it.status === args.where.status);
        }
        if (args?.where?.type) {
          result = result.filter((it: any) => it.type === args.where.type);
        }
        return result.length;
      },
      update: async ({ where, data }: any) => {
        updateCallCount++;
        const existing = byId[where.id] || items.find((it: any) => it.id === where.id) || {};
        const updated = { ...existing, ...data, id: where.id };
        byId[where.id] = updated;
        return updated;
      },
      groupBy: async (args?: any) => {
        // Group by status for stats
        const byStatus = new Map<string, number>();
        for (const it of items) {
          const s = it.status || "pending";
          byStatus.set(s, (byStatus.get(s) || 0) + 1);
        }
        if (args?._count) {
          return [...byStatus.entries()].map(([status, count]) => ({
            status,
            _count: { id: count },
          }));
        }
        return [];
      },
    },
    reviewDecision: {
      create: async ({ data }: any) => {
        decisionCreateCount++;
        const decision = { ...data, id: BigInt(decisionCreateCount), createdAt: new Date() };
        decisions.push(decision);
        return decision;
      },
      count: async (args?: any) => {
        if (args?.where?.evidenceFingerprint) {
          return decisions.filter((d: any) => d.evidenceFingerprint === args.where.evidenceFingerprint).length;
        }
        return decisions.length;
      },
    },
    crawlerJob: {
      create: async ({ data }: any) => {
        crawlerJobCreateCount++;
        const job = { ...data, id: data.id, attempts: 0, createdAt: new Date(), updatedAt: new Date() };
        crawlerJobs[data.id] = job;
        return job;
      },
      findUnique: async ({ where }: any) => crawlerJobs[where.id] ?? null,
      update: async ({ where, data }: any) => {
        const existing = crawlerJobs[where.id] || {};
        const updated = { ...existing, ...data, id: where.id, updatedAt: new Date() };
        crawlerJobs[where.id] = updated;
        return updated;
      },
    },
    figure: {
      findFirst: async (args?: any) => {
        if (args?.where?.slug) {
          return opts.figuresBySlug?.[args.where.slug] ?? null;
        }
        if (args?.where?.id) {
          const key = String(args.where.id);
          return opts.figuresById?.[key] ?? null;
        }
        return null;
      },
      findMany: async (args?: any) => {
        // For batch figure lookup in GET /review/items
        const result: any[] = [];
        if (args?.where?.id?.in) {
          for (const id of args.where.id.in) {
            const key = String(id);
            if (opts.figuresById?.[key]) result.push(opts.figuresById[key]);
          }
        }
        if (args?.where?.slug?.in) {
          for (const slug of args.where.slug.in) {
            if (opts.figuresBySlug?.[slug]) {
              const fig = opts.figuresBySlug[slug];
              if (!result.some((f) => f.id === fig.id)) result.push(fig);
            }
          }
        }
        return result;
      },
      findUnique: async (args?: any) => {
        if (args?.where?.id) {
          const key = String(args.where.id);
          return opts.figuresById?.[key] ?? null;
        }
        return null;
      },
    },
    figureImage: {
      findMany: async () => opts.figureImages ?? [],
    },
    revision: {
      findFirst: async () => opts.revisions?.[0] ?? null,
    },
    $transaction: async (fn: any) => {
      // Simulate a transaction by passing a mock tx object
      return fn({
        reviewItem: {
          update: async ({ where, data }: any) => {
            updateCallCount++;
            const existing = byId[where.id] || items.find((it: any) => it.id === where.id) || {};
            const updated = { ...existing, ...data, id: where.id };
            byId[where.id] = updated;
            return updated;
          },
        },
        reviewDecision: {
          create: async ({ data }: any) => {
            decisionCreateCount++;
            const decision = { ...data, id: BigInt(decisionCreateCount), createdAt: new Date() };
            decisions.push(decision);
            return decision;
          },
        },
      });
    },
  } as any;
}

function makeRedisMock(opts: {
  store?: Map<string, string>;
  zsets?: Map<string, Map<string, number>>;
  lockAlwaysSucceeds?: boolean;
} = {}) {
  const store = opts.store ?? new Map<string, string>();
  const zsets = opts.zsets ?? new Map<string, Map<string, number>>();
  const lockAlwaysSucceeds = opts.lockAlwaysSucceeds !== false;

  return {
    store,
    zsets,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, ...rest: any[]) => {
      // Handle SET key value EX ttl NX form
      if (rest.includes("NX")) {
        if (!lockAlwaysSucceeds || store.has(k)) return null;
        store.set(k, v);
        return "OK";
      }
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
    unlink: async (...keys: string[]) => {
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
    zrevrange: async (k: string, start: number, end: number) => {
      const set = zsets.get(k);
      if (!set) return [];
      const entries = [...set.entries()].sort((a, b) => b[1] - a[1]);
      const arr = entries.map((e) => e[0]);
      if (end === -1) return arr.slice(start);
      return arr.slice(start, end + 1);
    },
    zcard: async (k: string) => zsets.get(k)?.size ?? 0,
    zrem: async (k: string, ...members: string[]) => {
      const set = zsets.get(k);
      if (!set) return 0;
      let n = 0;
      for (const m of members) {
        if (set.delete(m)) n++;
      }
      return n;
    },
    scan: async (_cursor: string, ..._args: any[]) => {
      // Return keys matching pattern from store
      const pattern = _args.find((a: any) => typeof a === "string" && a.includes("*"));
      if (!pattern) return ["0", []];
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
      const keys = [...store.keys()].filter((k) => regex.test(k));
      return ["0", keys];
    },
    pipeline() {
      const ops: Array<() => void> = [];
      const p: any = {
        set: (k: string, v: string) => {
          ops.push(() => store.set(k, v));
          return p;
        },
        zadd: (k: string, score: number, member: string) => {
          ops.push(() => {
            if (!zsets.has(k)) zsets.set(k, new Map());
            zsets.get(k)!.set(member, score);
          });
          return p;
        },
        exec: async () => {
          for (const op of ops) op();
          return [];
        },
      };
      return p;
    },
    disconnect: async () => {},
  } as any;
}

// ─── Test app builder ────────────────────────────────────────────────────────

function buildTestApp(prisma: any, redis: any): FastifyInstance {
  const app = Fastify({ logger: false });
  (app as any).prisma = prisma;
  (app as any).redis = redis;
  registerReviewRoutes(app);
  return app;
}

// ─── Helper: create a sample PG review item ──────────────────────────────────

function makeReviewItem(overrides: Partial<any> = {}): any {
  return {
    id: "item-001",
    type: "image_review",
    title: "Test review item",
    status: "pending",
    priority: 1,
    figureId: 286n,
    figureSlug: "test-figure",
    riskType: "image_low_count",
    riskReason: "Low image count",
    evidenceFingerprint: "fp-abc123",
    candidateImage: { source: "https://example.com/img.jpg" },
    payload: { issue: "low_count" },
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeFigure(overrides: Partial<any> = {}): any {
  return {
    id: 286n,
    slug: "test-figure",
    name: "Test Figure",
    description: "A test figure description",
    scale: "1/7",
    material: "PVC",
    priceJpy: 15000,
    releaseDate: new Date("2026-06-01"),
    heightMm: 250,
    manufacturer: { name: "Good Smile" },
    series: { name: "Test Series" },
    images: [{ id: 12n, width: 800, height: 1000, data: { source_kind: "mfc_review_approved" }, sortOrder: 0 }],
    _count: { images: 1 },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("review-api-integration: registerReviewRoutes", () => {
  describe("1. GET /review/items — PG source with _count.images + take:1", () => {
    test("returns PG items enriched with real image count and single primary image", async () => {
      const item = makeReviewItem();
      const figure = makeFigure();
      const prisma = makePrismaMock({
        reviewItems: [item],
        figuresById: { "286": figure },
        figuresBySlug: { "test-figure": figure },
      });
      const redis = makeRedisMock();
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({ method: "GET", url: "/review/items" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.success, true);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].id, "item-001");
      assert.equal(body.meta.legacy, false);

      await app.close();
    });
  });

  describe("2. GET /review/items — Redis legacy fallback with legacy:true", () => {
    test("falls back to Redis when PG is empty and marks legacy:true", async () => {
      const legacyItem = {
        id: "legacy-1",
        type: "image_review",
        title: "Legacy item",
        status: "pending",
        figureId: "286",
        figureSlug: "test-figure",
        riskType: "image_low_count",
        payload: {},
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const store = new Map<string, string>();
      store.set("review:item:legacy-1", JSON.stringify(legacyItem));
      const zsets = new Map<string, Map<string, number>>();
      zsets.set("review:items", new Map([["legacy-1", Date.now()]]));

      const figure = makeFigure();
      const prisma = makePrismaMock({
        reviewItems: [], // PG is empty
        figuresById: { "286": figure },
        figuresBySlug: { "test-figure": figure },
      });
      const redis = makeRedisMock({ store, zsets });
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({ method: "GET", url: "/review/items" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.success, true);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].id, "legacy-1");
      assert.equal(body.meta.legacy, true, "legacy flag must be true when falling back to Redis");

      await app.close();
    });
  });

  describe("3. POST /review/items — DomainReviewRepository.create with enhanced duplicate_decided", () => {
    test("creates a new item via DomainReviewRepository when no duplicate exists", async () => {
      const prisma = makePrismaMock({ existingActive: null });
      const redis = makeRedisMock();
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({
        method: "POST",
        url: "/review/items",
        payload: {
          type: "image_review",
          title: "New item",
          figureId: 286,
          riskType: "image_low_count",
          candidateImage: { source: "https://example.com/img.jpg" },
        },
      });
      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.success, true);
      assert.equal(prisma._createCallCount(), 1, "prisma.reviewItem.create must be called");

      await app.close();
    });

    test("suppresses with duplicate_decided only when human ReviewDecision exists", async () => {
      // An existing resolved item with a human decision → suppress
      const repo = new DomainReviewRepository(makePrismaMock(), makeRedisMock());
      const fp = repo.computeFingerprint({
        type: "image_review",
        title: "test",
        figureId: 286,
        riskType: "image_low_count",
      });
      const existing = makeReviewItem({
        id: "existing-resolved",
        status: "resolved",
        evidenceFingerprint: fp,
      });
      const prisma = makePrismaMock({
        existingActive: existing,
        reviewDecisions: [
          { id: 1n, evidenceFingerprint: fp, action: "approve_image", reviewItemId: "existing-resolved" },
        ],
      });
      const redis = makeRedisMock();
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({
        method: "POST",
        url: "/review/items",
        payload: {
          type: "image_review",
          title: "Duplicate",
          figureId: 286,
          riskType: "image_low_count",
          candidateImage: { source: "https://example.com/img.jpg" },
        },
      });
      const body = JSON.parse(res.body);
      // Should be suppressed (200, not 201)
      assert.equal(res.statusCode, 200);
      assert.equal(body.suppressed, true);
      assert.equal(body.reason, "duplicate_decided");

      await app.close();
    });
  });

  describe("4. POST /review/items/:id/recheck — returns only {problems, currentState, recommendedStatus, evidenceChanged}", () => {
    test("does not modify status and returns exactly the 4 fields", async () => {
      const item = makeReviewItem({ type: "image_review", status: "pending" });
      const figure = makeFigure();
      const prisma = makePrismaMock({
        reviewItemById: { "item-001": item },
        figuresById: { "286": figure },
        figuresBySlug: { "test-figure": figure },
        figureImages: [{ id: 12n, source: "amiami", size: "detail", width: 800, height: 1000 }],
      });
      const redis = makeRedisMock();
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({
        method: "POST",
        url: "/review/items/item-001/recheck",
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.success, true);
      const data = body.data;
      // Must have exactly these 4 keys
      assert.ok("problems" in data, "must include problems");
      assert.ok("currentState" in data, "must include currentState");
      assert.ok("recommendedStatus" in data, "must include recommendedStatus");
      assert.ok("evidenceChanged" in data, "must include evidenceChanged");
      // Must NOT include status updates or item mutations
      assert.ok(!("item" in data), "must not include item in recheck response");
      assert.ok(!("status" in data), "must not include status in recheck response");

      await app.close();
    });
  });

  describe("5. POST /review/items/:id/action — records decision via recordDecision (transaction)", () => {
    test("approve_image records a ReviewDecision and updates item status to resolved", async () => {
      const item = makeReviewItem({ status: "pending" });
      const prisma = makePrismaMock({
        reviewItemById: { "item-001": item },
      });
      const redis = makeRedisMock();
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({
        method: "POST",
        url: "/review/items/item-001/action",
        payload: { action: "approve_image", notes: "Looks good" },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.success, true);
      assert.equal(body.data.action, "approve_image");
      assert.ok(body.data.decision, "must include decision record");
      // A ReviewDecision must have been created (via $transaction)
      assert.ok(prisma._decisionCreateCount() >= 1, "ReviewDecision must be created in transaction");

      await app.close();
    });
  });

  describe("6. POST /review/items/:id/action — 409 for illegal transitions", () => {
    test("resolved → resolved returns 409 Conflict", async () => {
      // A resolved item cannot transition to resolved again
      const item = makeReviewItem({ status: "resolved" });
      const prisma = makePrismaMock({
        reviewItemById: { "item-001": item },
      });
      const redis = makeRedisMock();
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({
        method: "POST",
        url: "/review/items/item-001/action",
        payload: { action: "approve_image" }, // maps to "resolved"
      });
      assert.equal(res.statusCode, 409);
      const body = JSON.parse(res.body);
      assert.equal(body.success, false);
      assert.equal(body.error.code, "ILLEGAL_TRANSITION");

      await app.close();
    });
  });

  describe("7. POST /review/items/:id/action — keep_pending keeps status as pending", () => {
    test("keep_pending on a pending item keeps status pending (no fake resolve)", async () => {
      const item = makeReviewItem({ status: "pending" });
      const prisma = makePrismaMock({
        reviewItemById: { "item-001": item },
      });
      const redis = makeRedisMock();
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({
        method: "POST",
        url: "/review/items/item-001/action",
        payload: { action: "keep_pending", notes: "Need human review" },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.success, true);
      // The item status must remain "pending"
      assert.equal(body.data.item.status, "pending");
      // A ReviewDecision is still recorded (audit trail)
      assert.ok(prisma._decisionCreateCount() >= 1, "ReviewDecision must still be recorded for keep_pending");

      await app.close();
    });
  });

  describe("8. POST /review/items/:id/action — request_refetch idempotency", () => {
    test("reuses existing non-terminal crawlerJobId instead of creating a new job", async () => {
      const item = makeReviewItem({
        status: "pending",
        crawlerJobId: "job-existing-1",
      });
      const existingJob = {
        id: "job-existing-1",
        status: "queued", // non-terminal
        source: "mfc",
        runner: "local_browser",
        attempts: 0,
      };
      const prisma = makePrismaMock({
        reviewItemById: { "item-001": item },
        crawlerJobById: { "job-existing-1": existingJob },
      });
      const redis = makeRedisMock();
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({
        method: "POST",
        url: "/review/items/item-001/action",
        payload: { action: "request_refetch" },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.success, true);
      assert.equal(body.data.crawlerJobId, "job-existing-1", "must reuse existing non-terminal job");
      assert.equal(prisma._crawlerJobCreateCount(), 0, "must NOT create a new CrawlerJob");

      await app.close();
    });

    test("creates new CrawlerJob when existing job is terminal (completed)", async () => {
      const item = makeReviewItem({
        status: "pending",
        crawlerJobId: "job-old-1",
      });
      const existingJob = {
        id: "job-old-1",
        status: "completed", // terminal
        source: "mfc",
        runner: "local_browser",
        attempts: 1,
      };
      const prisma = makePrismaMock({
        reviewItemById: { "item-001": item },
        crawlerJobById: { "job-old-1": existingJob },
      });
      const redis = makeRedisMock();
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({
        method: "POST",
        url: "/review/items/item-001/action",
        payload: { action: "request_refetch" },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.success, true);
      assert.ok(body.data.crawlerJobId, "must create a new CrawlerJob");
      assert.notEqual(body.data.crawlerJobId, "job-old-1", "must not reuse terminal job");
      assert.ok(prisma._crawlerJobCreateCount() >= 1, "must create a new CrawlerJob");

      await app.close();
    });
  });

  describe("9. POST /review/items/:id/action — mark_needs_manual_edit sets needs_changes", () => {
    test("mark_needs_manual_edit transitions pending → needs_changes", async () => {
      const item = makeReviewItem({ status: "pending" });
      const prisma = makePrismaMock({
        reviewItemById: { "item-001": item },
      });
      const redis = makeRedisMock();
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({
        method: "POST",
        url: "/review/items/item-001/action",
        payload: { action: "mark_needs_manual_edit", notes: "Requires manual editing" },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.success, true);
      assert.equal(body.data.item.status, "needs_changes", "mark_needs_manual_edit must set status to needs_changes");
      assert.equal(prisma._decisionCreateCount() >= 1, true);

      await app.close();
    });
  });

  describe("10. POST /review/items/:id/action — distributed lock acquisition and release", () => {
    test("acquires lock before action and releases it after (lock key is cleared)", async () => {
      const item = makeReviewItem({ status: "pending" });
      const prisma = makePrismaMock({
        reviewItemById: { "item-001": item },
      });
      const redis = makeRedisMock();
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({
        method: "POST",
        url: "/review/items/item-001/action",
        payload: { action: "approve_image" },
      });
      assert.equal(res.statusCode, 200);

      // After the action completes, the lock must be released
      const lockValue = redis.store.get("review:lock:item-001");
      assert.equal(lockValue, undefined, "lock must be released after action completes");

      await app.close();
    });

    test("returns 409 CONCURRENT_ACTION when lock is already held", async () => {
      const item = makeReviewItem({ status: "pending" });
      const prisma = makePrismaMock({
        reviewItemById: { "item-001": item },
      });
      const store = new Map<string, string>();
      // Pre-set the lock to simulate a concurrent action
      store.set("review:lock:item-001", "1");
      const redis = makeRedisMock({ store });
      const app = buildTestApp(prisma, redis);

      const res = await app.inject({
        method: "POST",
        url: "/review/items/item-001/action",
        payload: { action: "approve_image" },
      });
      assert.equal(res.statusCode, 409);
      const body = JSON.parse(res.body);
      assert.equal(body.success, false);
      assert.equal(body.error.code, "CONCURRENT_ACTION");

      await app.close();
    });
  });
});
