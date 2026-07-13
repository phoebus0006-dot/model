// Tests for /health and /ready endpoints (src/plugins/readiness.ts).
// Run: npx tsx --test src/plugins/readiness.test.ts
//
// These tests use a lightweight Fastify instance with mocked Prisma and
// Redis to verify the readiness probe behavior without real dependencies.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { FastifyInstance } from "fastify";
import { registerReadinessRoutes } from "./readiness.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

function makePrismaMock(opts: { fail?: boolean } = {}) {
  return {
    async $queryRaw() {
      if (opts.fail) throw new Error("PG connection refused");
      return [{ "?column?": 1 }];
    },
  };
}

function makeRedisMock(opts: { fail?: boolean; pong?: string } = {}) {
  return {
    async ping() {
      if (opts.fail) throw new Error("Redis connection refused");
      return opts.pong ?? "PONG";
    },
  };
}

async function buildApp(opts: {
  prisma?: any;
  redis?: any;
} = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("prisma", opts.prisma ?? makePrismaMock());
  app.decorate("redis", opts.redis ?? makeRedisMock());
  registerReadinessRoutes(app);
  await app.ready();
  return app;
}

// ─── /health tests ──────────────────────────────────────────────────────────

describe("/health endpoint", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test("returns 200 with { status: 'ok' }", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ok");
  });

  test("does not check any external dependencies (always ok)", async () => {
    // Even with failing prisma/redis, /health should return 200
    const failingApp = await buildApp({
      prisma: makePrismaMock({ fail: true }),
      redis: makeRedisMock({ fail: true }),
    });
    const res = await failingApp.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, "ok");
    await failingApp.close();
  });

  test("response does not include timestamp (liveness only)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json();
    assert.equal(body.timestamp, undefined);
  });
});

// ─── /ready tests ───────────────────────────────────────────────────────────

describe("/ready endpoint", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  test("returns 200 when both PG and Redis are ok", async () => {
    app = await buildApp({
      prisma: makePrismaMock(),
      redis: makeRedisMock(),
    });
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ready");
    assert.equal(body.checks.postgres, "ok");
    assert.equal(body.checks.redis, "ok");
  });

  test("returns 503 when PG fails", async () => {
    app = await buildApp({
      prisma: makePrismaMock({ fail: true }),
      redis: makeRedisMock(),
    });
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(res.statusCode, 503);
    const body = res.json();
    assert.equal(body.status, "not_ready");
    assert.equal(body.checks.postgres, "fail");
    assert.equal(body.checks.redis, "ok");
  });

  test("returns 503 when Redis fails", async () => {
    app = await buildApp({
      prisma: makePrismaMock(),
      redis: makeRedisMock({ fail: true }),
    });
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(res.statusCode, 503);
    const body = res.json();
    assert.equal(body.status, "not_ready");
    assert.equal(body.checks.postgres, "ok");
    assert.equal(body.checks.redis, "fail");
  });

  test("returns 503 when both PG and Redis fail", async () => {
    app = await buildApp({
      prisma: makePrismaMock({ fail: true }),
      redis: makeRedisMock({ fail: true }),
    });
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(res.statusCode, 503);
    const body = res.json();
    assert.equal(body.status, "not_ready");
    assert.equal(body.checks.postgres, "fail");
    assert.equal(body.checks.redis, "fail");
  });

  test("returns 503 when Redis ping returns non-PONG", async () => {
    app = await buildApp({
      prisma: makePrismaMock(),
      redis: makeRedisMock({ pong: "BUSY" }),
    });
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().checks.redis, "fail");
  });

  test("returns 503 when prisma is not decorated", async () => {
    app = Fastify({ logger: false });
    app.decorate("redis", makeRedisMock() as any);
    registerReadinessRoutes(app);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().checks.postgres, "fail");
    await app.close();
  });
});
