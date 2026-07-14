// Startup smoke test (contract section 11/12).
//
// Verifies that the Fastify application can reach app.ready() with all route
// plugins registered (using mocked Prisma/Redis — NO real DB required), that
// every registered route exposes a concrete HTTP method + path, and that no
// two routes collide on the same (method, path) pair.
//
// This is a SMOKE test, not a behavioural test: it guards against startup
// regressions (a route plugin throwing at registration time, a duplicate
// route silently shadowing another, a missing decorator). It does NOT assert
// business logic — that lives in test:unit / test:route / test:integration.
//
// Run: npm run test:smoke   (also executed by `npm run gate`)

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";

import { figureRoutes } from "../../src/routes/figures.js";
import { searchRoutes } from "../../src/routes/search.js";
import { categoryRoutes } from "../../src/routes/categories.js";
import { seriesRoutes } from "../../src/routes/series.js";
import { manufacturerRoutes } from "../../src/routes/manufacturer.js";
import { sculptorRoutes } from "../../src/routes/sculptor.js";
import { characterRoutes } from "../../src/routes/characters.js";
import { adminRoutes } from "../../src/routes/admin.js";
import { authRoutes } from "../../src/routes/auth.js";
import { imageRoutes } from "../../src/routes/images.js";
import { communityRoutes } from "../../src/routes/community.js";
import { installRedisFlushGuard } from "../../src/security/redisGuard.js";
import { registerBigIntSerializer } from "../../src/plugins/bigintSerializer.js";
import { registerReadinessRoutes } from "../../src/plugins/readiness.js";

const JWT_SECRET = "startup-smoke-test-secret-32chars-min!!";

// Mock Prisma / Redis (NO real DB). Only the surface area touched at
// registration time is needed; request-time behaviour is exercised by
// test:route / test:integration, not here.
function makePrismaMock(): any {
  return {
    user: { findUnique: async () => null, findFirst: async () => null },
    figure: { findFirst: async () => null, findUnique: async () => null, findMany: async () => [] },
  };
}

function makeRedisMock(): any {
  const store = new Map<string, string>();
  const mock: any = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => { store.set(k, v); return "OK"; },
    del: async () => 0,
    unlink: async () => 0,
    scan: async () => ["0", []],
    ping: async () => "PONG",
    pipeline() { return { set: () => this, zadd: () => this, exec: async () => [] }; },
    disconnect: async () => {},
    sendCommand: function (_command: any, ..._rest: any[]) { return undefined; },
  };
  return mock;
}

// Build the application mirroring src/index.ts registration order, but with
// mocks and without app.listen(). Returns the readied app.
// Uses the onRoute hook to capture a route inventory (Fastify v5 does not
// expose encapsulated plugin routes via app.routes on the parent instance).
async function buildReadiedApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("prisma", makePrismaMock());
  app.decorate("redis", makeRedisMock());

  const captured: { method: string; path: string }[] = [];
  app.decorate("capturedRoutes", captured);
  app.addHook("onRoute", (routeOptions: any) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    const path = routeOptions.url || routeOptions.path || "";
    for (const m of methods) {
      if (typeof m === "string" && m.length > 0) {
        captured.push({ method: m.toUpperCase(), path });
      }
    }
  });

  installRedisFlushGuard(app.redis as any);
  registerBigIntSerializer(app);
  registerReadinessRoutes(app);

  await app.register(cors, { origin: false, methods: ["GET", "POST", "PUT", "DELETE"] });
  await app.register(helmet, { contentSecurityPolicy: false, frameguard: false });
  await app.register(jwt, { secret: JWT_SECRET });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // Same prefixes as src/index.ts — must stay in sync.
  app.register(imageRoutes, { prefix: "/api/v1/figures/images" });
  app.register(figureRoutes, { prefix: "/api/v1/figures" });
  app.register(searchRoutes, { prefix: "/api/v1/search" });
  app.register(categoryRoutes, { prefix: "/api/v1/categories" });
  app.register(seriesRoutes, { prefix: "/api/v1/series" });
  app.register(manufacturerRoutes, { prefix: "/api/v1/manufacturers" });
  app.register(sculptorRoutes, { prefix: "/api/v1/sculptors" });
  app.register(characterRoutes, { prefix: "/api/v1/characters" });
  app.register(adminRoutes, { prefix: "/api/v1/admin" });
  app.register(authRoutes, { prefix: "/api/v1/auth" });
  app.register(communityRoutes, { prefix: "/api/v1" });

  await app.ready();
  return app;
}

// Extract a flat inventory of { method, path } from a readied Fastify app.
// Uses routes captured via the onRoute hook (stored as app.capturedRoutes).
function routeInventory(app: FastifyInstance): { method: string; path: string }[] {
  const captured = (app as any).capturedRoutes as { method: string; path: string }[] | undefined;
  if (!Array.isArray(captured)) return [];
  return captured.map(r => ({ method: r.method.toUpperCase(), path: r.path }));
}

describe("startup smoke — app.ready() + route inventory", () => {
  let app: FastifyInstance;

  after(async () => {
    if (app) await app.close();
  });

  test("app reaches ready state with all route plugins registered", async () => {
    app = await buildReadiedApp();
    assert.ok(app, "app.ready() must resolve without throwing");
  });

  test("route inventory is non-empty", () => {
    const inv = routeInventory(app);
    assert.ok(inv.length > 0, "expected registered routes, got " + inv.length);
  });

  test("every route has a concrete HTTP method and path", () => {
    const inv = routeInventory(app);
    const verbs = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    for (const r of inv) {
      assert.ok(r.method.length > 0, "route missing method: " + JSON.stringify(r));
      assert.ok(r.path.length > 0, "route missing path: " + JSON.stringify(r));
      assert.ok(verbs.includes(r.method), "unknown HTTP method " + r.method + " for path " + r.path);
      assert.ok(r.path.startsWith("/") || r.path === "*", "path must be absolute or wildcard: " + r.path);
    }
  });

  test("no duplicate (method, path) route registrations", () => {
    const inv = routeInventory(app);
    const seen = new Map<string, number>();
    const dupes: string[] = [];
    for (const r of inv) {
      const key = r.method + " " + r.path;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, n] of seen) {
      if (n > 1) dupes.push(key + " (x" + n + ")");
    }
    assert.deepEqual(dupes, [], "duplicate routes detected: " + dupes.join(", "));
  });

  test("core API prefixes are present in the inventory", () => {
    const inv = routeInventory(app);
    const paths = new Set(inv.map((r) => r.path));
    const requiredPrefixes = [
      "/api/v1/figures",
      "/api/v1/search",
      "/api/v1/categories",
      "/api/v1/series",
      "/api/v1/manufacturers",
      "/api/v1/sculptors",
      "/api/v1/characters",
      "/api/v1/admin",
      "/api/v1/auth",
      "/health",
      "/ready",
    ];
    const missing = requiredPrefixes.filter((p) => ![...paths].some((pp) => pp.startsWith(p)));
    assert.deepEqual(missing, [], "missing core route prefixes: " + missing.join(", "));
  });
});
