// Account isolation smoke test (contract section 13).
//
// Verifies the CURRENT role-based account-isolation property enforced by
// src/plugins/adminGuard.ts: a non-admin account (role=user or editor) MUST
// be rejected from admin-guarded routes (403), while an active admin MUST
// pass (200). Tokens are verified against the DB on every request, so a
// demoted/deactivated admin's existing JWT stops working immediately.
//
// This is a MOCK-based smoke (no real DB) that locks in the isolation
// invariant today. The FUTURE cross-system isolation (separate frontend
// email-User JWT vs guanli AdminAccount JWT, where an Admin JWT hitting a
// User-only route is rejected) is documented in
// tests/real/account-isolation.test.ts as a skeleton — it requires the
// Wave 2 AdminAccount model + real DB and is NOT_TESTED until then.
//
// Run: npm run test:smoke

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { verifyUserFromDb, ROLE_ADMIN } from "../../src/plugins/adminGuard.js";

const JWT_SECRET = "account-isolation-smoke-secret-32chars!!!";

interface MockUser {
  id: bigint;
  role: string;
  isActive: boolean;
  displayName: string;
}

function makePrismaMock(user: MockUser | null) {
  return {
    user: {
      async findUnique({ where }: { where: { id: bigint } }) {
        if (!user || user.id !== where.id) return null;
        return { id: user.id, role: user.role, isActive: user.isActive, displayName: user.displayName };
      },
    },
  };
}

async function buildAuthApp(user: MockUser | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as any).prisma = makePrismaMock(user);
  app.register(jwt, { secret: JWT_SECRET });
  app.get("/admin-only", async (req: any, reply: any) => {
    const ok = await verifyUserFromDb(app, req, reply, ROLE_ADMIN);
    if (!ok) return;
    return { ok: true };
  });
  await app.ready();
  return app;
}

function sign(app: FastifyInstance, userId: string, role: string): string {
  return (app as any).jwt.sign({ userId, role });
}

describe("account isolation — admin guard", () => {
  let app: FastifyInstance;
  afterEach(async () => { if (app) await app.close(); });

  test("User JWT (role=user) hitting admin route → 403", async () => {
    app = await buildAuthApp({ id: 2n, role: "user", isActive: true, displayName: "User" });
    const res = await app.inject({
      method: "GET",
      url: "/admin-only",
      headers: { authorization: "Bearer " + sign(app, "2", "admin") },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "FORBIDDEN");
  });

  test("Editor JWT (role=editor) hitting admin route → 403", async () => {
    app = await buildAuthApp({ id: 3n, role: "editor", isActive: true, displayName: "Editor" });
    const res = await app.inject({
      method: "GET",
      url: "/admin-only",
      headers: { authorization: "Bearer " + sign(app, "3", "admin") },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "FORBIDDEN");
  });

  test("Admin JWT (role=admin, active) hitting admin route → 200", async () => {
    app = await buildAuthApp({ id: 1n, role: "admin", isActive: true, displayName: "Admin" });
    const res = await app.inject({
      method: "GET",
      url: "/admin-only",
      headers: { authorization: "Bearer " + sign(app, "1", "admin") },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });

  test("Demoted admin's old JWT (DB now role=user) hitting admin route → 403", async () => {
    app = await buildAuthApp({ id: 10n, role: "user", isActive: true, displayName: "Demoted" });
    const res = await app.inject({
      method: "GET",
      url: "/admin-only",
      headers: { authorization: "Bearer " + sign(app, "10", "admin") },
    });
    assert.equal(res.statusCode, 403);
  });

  test("Deactivated admin's JWT hitting admin route → 401", async () => {
    app = await buildAuthApp({ id: 11n, role: "admin", isActive: false, displayName: "Deactivated" });
    const res = await app.inject({
      method: "GET",
      url: "/admin-only",
      headers: { authorization: "Bearer " + sign(app, "11", "admin") },
    });
    assert.equal(res.statusCode, 401);
  });

  test("Missing Authorization header hitting admin route → 401", async () => {
    app = await buildAuthApp({ id: 1n, role: "admin", isActive: true, displayName: "Admin" });
    const res = await app.inject({ method: "GET", url: "/admin-only" });
    assert.equal(res.statusCode, 401);
  });
});
