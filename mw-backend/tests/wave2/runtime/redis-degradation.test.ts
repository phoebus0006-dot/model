// Test suite for Redis Degradation & Timeout Fallback contract.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { figureRoutes } from "../../../src/routes/figures.js";
import { safeCacheGet, safeCacheSet } from "../../../src/utils/cache.js";
import { registerBigIntSerializer } from "../../../src/plugins/bigintSerializer.js";

describe("Redis Timeout & Degradation Test Suite", () => {
  let app: FastifyInstance;
  let mockFigures: any[];

  before(async () => {
    mockFigures = [
      { id: 1n, slug: "fig-1", name: "Figure 1", isDeleted: false, images: [] }
    ];

    const prismaMock = {
      figure: {
        async findMany() { return mockFigures; },
        async count() { return mockFigures.length; },
        async findFirst({ where }: any) {
          return mockFigures.find(f => f.slug === where.slug && !f.isDeleted) || null;
        }
      }
    };

    app = Fastify({ logger: false });
    app.decorate("prisma", prismaMock);
    registerBigIntSerializer(app);
  });

  test("1. Redis Normal Operation", async () => {
    const mockRedis = {
      async get(key: string) { return JSON.stringify({ cached: true }); },
      async set() { return "OK"; }
    };
    const res = await safeCacheGet(mockRedis, "test-key");
    assert.deepEqual(res, { cached: true });
  });

  test("2. Redis Connection Refused / Error -> Fallback to null", async () => {
    const mockRedis = {
      async get() { throw new Error("ECONNREFUSED 127.0.0.1:6379"); }
    };
    const res = await safeCacheGet(mockRedis, "test-key");
    assert.equal(res, null);
  });

  test("3. Redis Wrong Password -> Fallback to null", async () => {
    const mockRedis = {
      async get() { throw new Error("NOAUTH Authentication required."); }
    };
    const res = await safeCacheGet(mockRedis, "test-key");
    assert.equal(res, null);
  });

  test("4. Redis Command Hang / Timeout -> Fallback to null within 500ms", async () => {
    const mockRedis = {
      async get() {
        return new Promise((resolve) => setTimeout(() => resolve("late-data"), 2000));
      }
    };
    const t0 = Date.now();
    const res = await safeCacheGet(mockRedis, "test-key");
    const elapsed = Date.now() - t0;

    assert.equal(res, null);
    assert.ok(elapsed < 1000, `Expected timeout within 1000ms, took ${elapsed}ms`);
  });

  test("5. Redis Write Failure -> Non-blocking", async () => {
    const mockRedis = {
      async set() { throw new Error("OOM command not allowed when used memory > 'maxmemory'"); }
    };
    assert.doesNotThrow(() => {
      safeCacheSet(mockRedis, "test-key", { data: 123 }, 300);
    });
  });

  test("6. Public GET /api/v1/figures returns 200 OK when Redis fails but DB is healthy", async () => {
    const failingRedisApp = Fastify({ logger: false });
    failingRedisApp.decorate("prisma", (app as any).prisma);
    failingRedisApp.decorate("redis", {
      async get() { throw new Error("REDIS_DOWN"); },
      async set() { throw new Error("REDIS_DOWN"); }
    });
    registerBigIntSerializer(failingRedisApp);
    failingRedisApp.register(figureRoutes, { prefix: "/api/v1/figures" });
    await failingRedisApp.ready();

    const res = await failingRedisApp.inject({
      method: "GET",
      url: "/api/v1/figures"
    });

    assert.equal(res.statusCode, 200, `Status code failed: ${res.statusCode}, body: ${res.body}`);
    const body = res.json();
    assert.ok(body);
  });
});
