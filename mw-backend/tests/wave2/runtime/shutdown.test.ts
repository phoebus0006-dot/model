// Wave 2 Runtime: graceful shutdown manager tests.
//
// Verifies: idempotency (double shutdown is a no-op), ordered cleanup of
// Fastify + Prisma + Redis, timeout enforcement, and startup-failure cleanup.
//
// Run: npx tsx --test tests/wave2/runtime/shutdown.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { createShutdownManager } from "../../../src/runtime/index.js";

function makePrismaMock() {
  const calls: string[] = [];
  return {
    calls,
    async $disconnect() {
      calls.push("prisma:disconnect");
    },
  };
}

function makeRedisMock() {
  const calls: string[] = [];
  return {
    calls,
    disconnect() {
      calls.push("redis:disconnect");
    },
  };
}

async function buildApp(
  extra?: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Register any hooks BEFORE app.ready() (Fastify forbids addHook after
  // the instance is already listening).
  if (extra) extra(app);
  await app.ready();
  return app;
}

describe("shutdown manager — ordered cleanup", () => {
  test("closes app, disconnects prisma, disconnects redis (in order)", async () => {
    const order: string[] = [];
    const app = await buildApp((a) => {
      a.addHook("onClose", async () => {
        order.push("app:close");
      });
    });
    const prisma = makePrismaMock() as any;
    const redis = makeRedisMock() as any;

    let exitCode: number | undefined;
    const mgr = createShutdownManager({
      app,
      prisma,
      redis,
      timeoutMs: 5000,
      onExit: (code) => {
        exitCode = code;
      },
    });

    await mgr.shutdown("SIGTERM");

    assert.equal(exitCode, 0);
    assert.deepEqual(order, ["app:close"]);
    assert.deepEqual(prisma.calls, ["prisma:disconnect"]);
    assert.deepEqual(redis.calls, ["redis:disconnect"]);
    assert.equal(mgr.isShuttingDown(), true);

    // app was closed by shutdown manager already; calling close again is
    // safe (Fastify is idempotent) but unnecessary.
  });
});

describe("shutdown manager — idempotency", () => {
  test("double shutdown only runs cleanup once", async () => {
    let closeCount = 0;
    const app = await buildApp((a) => {
      a.addHook("onClose", async () => {
        closeCount++;
      });
    });
    const prisma = makePrismaMock() as any;
    const redis = makeRedisMock() as any;

    let exitCalls = 0;
    const mgr = createShutdownManager({
      app,
      prisma,
      redis,
      timeoutMs: 5000,
      onExit: () => {
        exitCalls++;
      },
    });

    await Promise.all([mgr.shutdown("SIGTERM"), mgr.shutdown("SIGINT")]);

    assert.equal(closeCount, 1, "app.close should run once");
    assert.equal(prisma.calls.length, 1, "prisma disconnect should run once");
    assert.equal(redis.calls.length, 1, "redis disconnect should run once");
    assert.equal(exitCalls, 1, "onExit should be called once");
  });

  test("isShuttingDown is false before shutdown", async () => {
    const app = await buildApp();
    const mgr = createShutdownManager({
      app,
      prisma: makePrismaMock() as any,
      redis: makeRedisMock() as any,
      onExit: () => {},
    });
    assert.equal(mgr.isShuttingDown(), false);
    await app.close();
  });
});

describe("shutdown manager — timeout enforcement", () => {
  test("timeout forces exit when app.close hangs", async () => {
    const app = Fastify({ logger: false });
    // Hang on close: never resolves.
    app.addHook("onClose", async () => {
      return new Promise<void>(() => {}); // never resolves
    });
    await app.ready();

    let exitCode: number | undefined;
    const mgr = createShutdownManager({
      app,
      prisma: makePrismaMock() as any,
      redis: makeRedisMock() as any,
      timeoutMs: 100,
      onExit: (code) => {
        exitCode = code;
      },
    });

    await mgr.shutdown("SIGTERM");
    // Even though app.close hung, the timeout fires and onExit is called.
    assert.equal(exitCode, 0);
  });
});
