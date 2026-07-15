// Admin guard isolation tests: audience enforcement, User JWT rejection,
// role enforcement (admin/reviewer/operator), disabled-admin real-time
// invalidation, and req.admin vs req.user separation.
//
// JWT setup: buildRoleApp registers DUAL JWT plugins (User + Admin namespaces
// with INDEPENDENT secrets) so that signAdminToken (which uses app.jwt.admin.sign)
// works correctly. This mirrors the production runtime.
//
// Run: npx tsx --test tests/wave2/admin-auth/guard-isolation.test.ts

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import {
  buildApp,
  makePrismaMock,
  makeRedisMock,
  seedAdmin,
  signAdmin,
  signUserToken,
  signTokenWithAud,
  USER_TEST_SECRET,
  ADMIN_TEST_SECRET,
  USER_JWT_AUDIENCE,
  ADMIN_JWT_AUDIENCE,
  ADMIN_JWT_TTL_SECONDS,
  type PrismaMock,
  type RedisMock,
} from "./helpers.js";
import { requireAdminRole } from "../../../src/plugins/admin-auth/guard.js";
import { adminAuthRoutes } from "../../../src/routes/admin-auth.js";

/**
 * Build an app that has:
 *   - DUAL jwt (User + Admin namespaces, independent secrets)
 *   - the admin auth routes (for login to mint tokens)
 *   - three role-gated test routes using requireAdminRole
 *     POST /admin-only   → requireAdminRole("admin")
 *     POST /review-only  → requireAdminRole("admin","reviewer")
 *     POST /operator-only → requireAdminRole("admin","operator")
 */
async function buildRoleApp(prisma: PrismaMock, redis: RedisMock): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  (app as unknown as { prisma: unknown }).prisma = prisma;
  (app as unknown as { redis: unknown }).redis = redis;
  // User JWT — default namespace (app.jwt.sign / app.jwt.verify)
  await app.register(jwt, {
    secret: USER_TEST_SECRET,
    sign: { algorithm: "HS256", aud: USER_JWT_AUDIENCE, expiresIn: "2h" },
    verify: { allowedAud: USER_JWT_AUDIENCE },
  });
  // Admin JWT — admin namespace (app.jwt.admin.sign / app.jwt.admin.verify)
  await app.register(jwt, {
    secret: ADMIN_TEST_SECRET,
    namespace: "admin",
    decoratorName: "admin",
    sign: { algorithm: "HS256", aud: ADMIN_JWT_AUDIENCE, expiresIn: ADMIN_JWT_TTL_SECONDS },
    verify: { allowedAud: ADMIN_JWT_AUDIENCE },
  });
  app.register(adminAuthRoutes);
  app.post("/admin-only", { preHandler: requireAdminRole("admin") }, async (_req, reply) => {
    return reply.status(200).send({ success: true, data: { scope: "admin" } });
  });
  app.post("/review-only", { preHandler: requireAdminRole("admin", "reviewer") }, async (_req, reply) => {
    return reply.status(200).send({ success: true, data: { scope: "review" } });
  });
  app.post("/operator-only", { preHandler: requireAdminRole("admin", "operator") }, async (_req, reply) => {
    return reply.status(200).send({ success: true, data: { scope: "operator" } });
  });
  await app.ready();
  return app;
}

describe("admin guard: audience enforcement + User JWT rejection", () => {
  let app: FastifyInstance;
  let prisma: PrismaMock;
  let redis: RedisMock;

  beforeEach(async () => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
    await seedAdmin(prisma, { username: "admin", password: "AdminPass!123", role: "admin" });
    app = await buildApp(prisma, redis);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test("User JWT (no aud) → /me → 401 INVALID_TOKEN", async () => {
    const userToken = signUserToken(app, { userId: "999", sessionVersion: 0 });
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "INVALID_TOKEN");
  });

  test("User JWT (aud=modelwiki-user) → /me → 401 INVALID_TOKEN", async () => {
    const userToken = signTokenWithAud(app, { userId: "999", sessionVersion: 0 }, "modelwiki-user");
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "INVALID_TOKEN");
  });

  test("Admin JWT with wrong aud → /me → 401 INVALID_TOKEN", async () => {
    const adminId = await seedAdmin(prisma, { username: "alice", password: "AlicePass!1", role: "admin" });
    const badToken = signTokenWithAud(
      app,
      { adminId, role: "admin", sessionVersion: 0 },
      "wrong-audience",
    );
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${badToken}` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "INVALID_TOKEN");
  });

  test("valid admin JWT with correct aud → /me → 200", async () => {
    const adminId = await seedAdmin(prisma, { username: "bob", password: "BobPass!12", role: "admin" });
    const token = signAdmin(app, { adminId, role: "admin", sessionVersion: 0 });
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.username, "bob");
  });

  test("garbage token → /me → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer not.a.real.token" },
    });
    assert.equal(res.statusCode, 401);
  });
});

describe("admin guard: role enforcement (admin/reviewer/operator)", () => {
  let app: FastifyInstance;
  let prisma: PrismaMock;
  let redis: RedisMock;

  beforeEach(async () => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
    app = await buildRoleApp(prisma, redis);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test("admin role can access admin-only route", async () => {
    const id = await seedAdmin(prisma, { username: "admin1", password: "AdminPass!123", role: "admin" });
    const token = signAdmin(app, { adminId: id, role: "admin", sessionVersion: 0 });
    const res = await app.inject({
      method: "POST",
      url: "/admin-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.scope, "admin");
  });

  test("reviewer CANNOT access admin-only route (403 FORBIDDEN)", async () => {
    const id = await seedAdmin(prisma, { username: "rev1", password: "RevPass!123", role: "reviewer" });
    const token = signAdmin(app, { adminId: id, role: "reviewer", sessionVersion: 0 });
    const res = await app.inject({
      method: "POST",
      url: "/admin-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "FORBIDDEN");
  });

  test("operator CANNOT access admin-only route (403 FORBIDDEN)", async () => {
    const id = await seedAdmin(prisma, { username: "op1", password: "OpPass!1234", role: "operator" });
    const token = signAdmin(app, { adminId: id, role: "operator", sessionVersion: 0 });
    const res = await app.inject({
      method: "POST",
      url: "/admin-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 403);
  });

  test("reviewer CAN access review-only route", async () => {
    const id = await seedAdmin(prisma, { username: "rev2", password: "RevPass!123", role: "reviewer" });
    const token = signAdmin(app, { adminId: id, role: "reviewer", sessionVersion: 0 });
    const res = await app.inject({
      method: "POST",
      url: "/review-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.scope, "review");
  });

  test("operator CANNOT access review-only route (403)", async () => {
    const id = await seedAdmin(prisma, { username: "op2", password: "OpPass!1234", role: "operator" });
    const token = signAdmin(app, { adminId: id, role: "operator", sessionVersion: 0 });
    const res = await app.inject({
      method: "POST",
      url: "/review-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 403);
  });

  test("operator CAN access operator-only route", async () => {
    const id = await seedAdmin(prisma, { username: "op3", password: "OpPass!1234", role: "operator" });
    const token = signAdmin(app, { adminId: id, role: "operator", sessionVersion: 0 });
    const res = await app.inject({
      method: "POST",
      url: "/operator-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.scope, "operator");
  });

  test("reviewer CANNOT access operator-only route (403)", async () => {
    const id = await seedAdmin(prisma, { username: "rev3", password: "RevPass!123", role: "reviewer" });
    const token = signAdmin(app, { adminId: id, role: "reviewer", sessionVersion: 0 });
    const res = await app.inject({
      method: "POST",
      url: "/operator-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 403);
  });

  test("admin CAN access review-only and operator-only (full access)", async () => {
    const id = await seedAdmin(prisma, { username: "admin2", password: "AdminPass!123", role: "admin" });
    const token = signAdmin(app, { adminId: id, role: "admin", sessionVersion: 0 });
    const reviewRes = await app.inject({
      method: "POST",
      url: "/review-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(reviewRes.statusCode, 200);
    const opRes = await app.inject({
      method: "POST",
      url: "/operator-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(opRes.statusCode, 200);
  });
});

describe("admin guard: disabled admin + demotion real-time invalidation", () => {
  let app: FastifyInstance;
  let prisma: PrismaMock;
  let redis: RedisMock;

  beforeEach(async () => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
    app = await buildRoleApp(prisma, redis);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test("disabled admin's existing token is immediately invalid (403 ACCOUNT_DISABLED)", async () => {
    const id = await seedAdmin(prisma, { username: "active", password: "ActivePass!1", role: "admin" });
    const token = signAdmin(app, { adminId: id, role: "admin", sessionVersion: 0 });

    // Admin is active → token works.
    const okRes = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(okRes.statusCode, 200);

    // Disable the admin in the DB (simulating another admin disabling them).
    const row = prisma._admins.get(id);
    assert.ok(row);
    row.isActive = false;

    // Same token → now rejected because the guard re-queries the DB.
    const disabledRes = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(disabledRes.statusCode, 403);
    assert.equal(disabledRes.json().error.code, "ACCOUNT_DISABLED");
  });

  test("demoted admin (role changed in DB) is checked against CURRENT DB role, not JWT role", async () => {
    // An admin is minted with role=admin in the JWT, but then demoted to
    // reviewer in the DB. The guard must use the DB role, so the admin-only
    // route must now return 403 even though the JWT still says admin.
    const id = await seedAdmin(prisma, { username: "demoted", password: "DemotedPass!1", role: "admin" });
    const token = signAdmin(app, { adminId: id, role: "admin", sessionVersion: 0 });

    // Before demotion: admin-only route works.
    const beforeRes = await app.inject({
      method: "POST",
      url: "/admin-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(beforeRes.statusCode, 200);

    // Demote in DB.
    const row = prisma._admins.get(id);
    assert.ok(row);
    row.role = "reviewer";

    // After demotion: admin-only route → 403 (DB role is reviewer, not admin).
    const afterRes = await app.inject({
      method: "POST",
      url: "/admin-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(afterRes.statusCode, 403);
    assert.equal(afterRes.json().error.code, "FORBIDDEN");

    // But review-only route now works (DB role is reviewer).
    const reviewRes = await app.inject({
      method: "POST",
      url: "/review-only",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(reviewRes.statusCode, 200);
  });

  test("unknown role in DB → 403 FORBIDDEN (least privilege)", async () => {
    const id = await seedAdmin(prisma, { username: "weird", password: "WeirdPass!1", role: "admin" });
    const token = signAdmin(app, { adminId: id, role: "admin", sessionVersion: 0 });

    // Corrupt the role in DB to something invalid.
    const row = prisma._admins.get(id);
    assert.ok(row);
    row.role = "superuser"; // not in the valid vocabulary

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "FORBIDDEN");
  });
});
