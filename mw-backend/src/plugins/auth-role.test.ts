// Tests for admin guard authorization (src/plugins/adminGuard.ts).
// Run: npx tsx --test src/plugins/auth-role.test.ts
//
// These tests verify that:
//   1. Normal users (role="user") are rejected from admin endpoints (403)
//   2. Editors (role="editor") are rejected from admin-only endpoints (403)
//   3. A demoted admin's old JWT stops working immediately (DB role is checked)
//   4. A deactivated admin's old JWT stops working immediately (isActive=false)
//   5. req.user is populated with { userId, role, displayName } on success
//   6. Invalid/expired tokens are rejected (401)

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import {
  verifyUserFromDb,
  normalizeRole,
  ROLE_ADMIN,
  VALID_ROLES,
} from "./adminGuard.js";

const JWT_SECRET = "test-secret-for-auth-role-tests-only-32chars!!";

// ─── Mocks ──────────────────────────────────────────────────────────────────

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
        if (!user) return null;
        if (user.id !== where.id) return null;
        return {
          id: user.id,
          role: user.role,
          isActive: user.isActive,
          displayName: user.displayName,
        };
      },
    },
  };
}

function makeApp(user: MockUser | null): FastifyInstance {
  const app = Fastify({ logger: false });
  (app as any).prisma = makePrismaMock(user);
  app.register(jwt, { secret: JWT_SECRET });
  return app;
}

// Helper: set up an app with a test route that runs verifyUserFromDb
async function buildAuthApp(user: MockUser | null): Promise<FastifyInstance> {
  const app = makeApp(user);
  app.get("/test", async (req: any, reply: any) => {
    const ok = await verifyUserFromDb(app, req, reply, ROLE_ADMIN);
    if (!ok) return;
    return { ok: true, user: (req as any).user };
  });
  await app.ready();
  return app;
}

// ─── normalizeRole tests ────────────────────────────────────────────────────

describe("normalizeRole", () => {
  test("returns valid roles as-is (lowercased)", () => {
    assert.equal(normalizeRole("user"), "user");
    assert.equal(normalizeRole("editor"), "editor");
    assert.equal(normalizeRole("admin"), "admin");
    assert.equal(normalizeRole("ADMIN"), "admin");
    assert.equal(normalizeRole("Editor"), "editor");
  });

  test("falls back to 'user' for unknown roles", () => {
    assert.equal(normalizeRole("viewer"), "user");
    assert.equal(normalizeRole("superadmin"), "user");
    assert.equal(normalizeRole(""), "user");
    assert.equal(normalizeRole(null as any), "user");
    assert.equal(normalizeRole(undefined as any), "user");
  });

  test("VALID_ROLES contains exactly user, editor, admin", () => {
    assert.deepEqual([...VALID_ROLES], ["user", "editor", "admin"]);
  });
});

// ─── Admin guard: DB role check tests ───────────────────────────────────────

describe("admin guard — DB role re-check", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  test("admin user with valid JWT passes (200)", async () => {
    const user: MockUser = {
      id: BigInt(1),
      role: "admin",
      isActive: true,
      displayName: "Admin User",
    };
    app = await buildAuthApp(user);
    const token = (app as any).jwt.sign({ userId: "1", role: "admin" });
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.user.userId, "1");
    assert.equal(body.user.role, "admin");
    assert.equal(body.user.displayName, "Admin User");
  });

  test("normal user (role=user) is rejected with 403", async () => {
    const user: MockUser = {
      id: BigInt(2),
      role: "user",
      isActive: true,
      displayName: "Normal User",
    };
    app = await buildAuthApp(user);
    // JWT says admin, but DB says user — must be rejected
    const token = (app as any).jwt.sign({ userId: "2", role: "admin" });
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "FORBIDDEN");
  });

  test("editor (role=editor) is rejected from admin-only endpoint with 403", async () => {
    const user: MockUser = {
      id: BigInt(3),
      role: "editor",
      isActive: true,
      displayName: "Editor User",
    };
    app = await buildAuthApp(user);
    const token = (app as any).jwt.sign({ userId: "3", role: "admin" });
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "FORBIDDEN");
  });

  test("demoted admin's old JWT is rejected (DB role now 'user')", async () => {
    // Scenario: user was admin when JWT was issued, but has since been
    // demoted to 'user'. The JWT still says role=admin, but the DB now
    // returns role=user. The guard must reject.
    const userAfterDemotion: MockUser = {
      id: BigInt(10),
      role: "user", // demoted!
      isActive: true,
      displayName: "Demoted Admin",
    };
    app = await buildAuthApp(userAfterDemotion);
    const token = (app as any).jwt.sign({ userId: "10", role: "admin" });
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "FORBIDDEN");
  });

  test("deactivated admin's old JWT is rejected (isActive=false)", async () => {
    // Scenario: admin was deactivated. JWT is still valid cryptographically,
    // but the DB shows isActive=false. Must be rejected with 401.
    const deactivatedUser: MockUser = {
      id: BigInt(11),
      role: "admin",
      isActive: false, // deactivated!
      displayName: "Deactivated Admin",
    };
    app = await buildAuthApp(deactivatedUser);
    const token = (app as any).jwt.sign({ userId: "11", role: "admin" });
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "UNAUTHORIZED");
  });

  test("nonexistent user (DB returns null) is rejected with 401", async () => {
    app = await buildAuthApp(null);
    const token = (app as any).jwt.sign({ userId: "999", role: "admin" });
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "UNAUTHORIZED");
  });
});

// ─── Admin guard: token validation tests ────────────────────────────────────

describe("admin guard — token validation", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  test("missing Authorization header → 401", async () => {
    app = await buildAuthApp({
      id: BigInt(1),
      role: "admin",
      isActive: true,
      displayName: "Admin",
    });
    const res = await app.inject({ method: "GET", url: "/test" });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "UNAUTHORIZED");
  });

  test("malformed Authorization header (no Bearer prefix) → 401", async () => {
    app = await buildAuthApp({
      id: BigInt(1),
      role: "admin",
      isActive: true,
      displayName: "Admin",
    });
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Token abc123" },
    });
    assert.equal(res.statusCode, 401);
  });

  test("invalid JWT token → 401", async () => {
    app = await buildAuthApp({
      id: BigInt(1),
      role: "admin",
      isActive: true,
      displayName: "Admin",
    });
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: "Bearer not-a-valid-jwt" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "INVALID_TOKEN");
  });

  test("JWT with non-numeric userId → 401", async () => {
    app = await buildAuthApp({
      id: BigInt(1),
      role: "admin",
      isActive: true,
      displayName: "Admin",
    });
    const token = (app as any).jwt.sign({ userId: "not-a-number", role: "admin" });
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "INVALID_TOKEN");
  });

  test("JWT with userId > MAX_SAFE_INTEGER works (BigInt precision preserved)", async () => {
    // The admin guard must handle BigInt user IDs correctly — no precision loss
    const hugeId = BigInt("9007199254740993"); // MAX_SAFE_INTEGER + 2
    app = await buildAuthApp({
      id: hugeId,
      role: "admin",
      isActive: true,
      displayName: "Huge ID Admin",
    });
    const token = (app as any).jwt.sign({
      userId: hugeId.toString(),
      role: "admin",
    });
    const res = await app.inject({
      method: "GET",
      url: "/test",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.userId, hugeId.toString());
  });
});
