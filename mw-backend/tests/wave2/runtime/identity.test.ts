// Wave 2 Runtime: identity collision guard tests.
//
// Verifies that a request carrying BOTH a user identity (req.user) and an
// admin identity (req.admin) is rejected with 400 DUAL_IDENTITY_FORBIDDEN,
// while a request with only one (or neither) identity passes through.
//
// Run: npx tsx --test tests/wave2/runtime/identity.test.ts

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { registerIdentityCollisionGuard } from "../../../src/runtime/index.js";

async function buildApp(
  extra?: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerIdentityCollisionGuard(app);
  // Register any extra hooks BEFORE app.ready() (Fastify forbids addHook
  // after the instance is already listening).
  if (extra) extra(app);
  app.get("/probe", async (req: any) => {
    return {
      hasUser: req.user !== undefined && req.user !== null,
      hasAdmin: req.admin !== undefined && req.admin !== null,
    };
  });
  await app.ready();
  return app;
}

describe("identity collision guard", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    if (app) await app.close();
  });

  test("no identity → passes", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/probe" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().hasUser, false);
    assert.equal(res.json().hasAdmin, false);
  });

  test("only user identity → passes", async () => {
    app = await buildApp((a) => {
      a.addHook("preHandler", async (req: any) => {
        req.user = { userId: "1", role: "user", displayName: "U" };
      });
    });
    const res = await app.inject({ method: "GET", url: "/probe" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().hasUser, true);
    assert.equal(res.json().hasAdmin, false);
  });

  test("only admin identity → passes", async () => {
    app = await buildApp((a) => {
      a.addHook("preHandler", async (req: any) => {
        req.admin = { adminId: "1", role: "admin", sessionVersion: 0 };
      });
    });
    const res = await app.inject({ method: "GET", url: "/probe" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().hasUser, false);
    assert.equal(res.json().hasAdmin, true);
  });

  test("both user and admin identity → 400 DUAL_IDENTITY_FORBIDDEN", async () => {
    // Set BOTH identities in onRequest (runs before any preHandler, including
    // the collision guard). The guard must observe both and reject.
    app = await buildApp((a) => {
      a.addHook("onRequest", async (req: any) => {
        req.user = { userId: "1", role: "user", displayName: "U" };
        req.admin = { adminId: "2", role: "admin", sessionVersion: 0 };
      });
    });
    const res = await app.inject({ method: "GET", url: "/probe" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "DUAL_IDENTITY_FORBIDDEN");
  });

  test("admin identity set first, then user → still rejected", async () => {
    // Same as above but with admin set first. Order of assignment must not
    // matter — the guard only checks the final state when it runs.
    app = await buildApp((a) => {
      a.addHook("onRequest", async (req: any) => {
        req.admin = { adminId: "1", role: "admin", sessionVersion: 0 };
        req.user = { userId: "2", role: "user", displayName: "U" };
      });
    });
    const res = await app.inject({ method: "GET", url: "/probe" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "DUAL_IDENTITY_FORBIDDEN");
  });

  test("falsy user identity (null) does not trigger collision", async () => {
    app = await buildApp((a) => {
      a.addHook("preHandler", async (req: any) => {
        req.user = null;
        req.admin = { adminId: "1", role: "admin", sessionVersion: 0 };
      });
    });
    const res = await app.inject({ method: "GET", url: "/probe" });
    assert.equal(res.statusCode, 200);
  });
});
