// Admin auth route tests: login, email rejection, wrong password, inactive
// admin, username normalization, change-password, and sessionVersion
// invalidation. Mock-based (no DB required).
//
// Run: npx tsx --test tests/wave2/admin-auth/admin-login.test.ts

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import {
  buildApp,
  makePrismaMock,
  makeRedisMock,
  seedAdmin,
  signAdmin,
  getSetCookies,
} from "./helpers.js";

describe("admin login + change-password + sessionVersion", () => {
  let app: FastifyInstance;
  let prisma: ReturnType<typeof makePrismaMock>;
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
    await seedAdmin(prisma, { username: "admin", password: "AdminPass!123", role: "admin" });
    app = await buildApp(prisma, redis);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test("username login success (200) — sets mw_admin_token cookie + returns token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.admin.username, "admin");
    assert.equal(body.data.admin.role, "admin");
    assert.equal(typeof body.data.token, "string");
    // Cookie is set, httpOnly, correct name, scoped path.
    const setCookie = getSetCookies(res);
    assert.ok(setCookie.length > 0);
    const cookie = setCookie[0];
    assert.ok(cookie.startsWith("mw_admin_token="));
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("Path=/api/v1/admin"));
    assert.ok(cookie.includes("SameSite=Lax"));
  });

  test("email field is rejected with 400 EMAIL_NOT_SUPPORTED", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email: "admin@example.com", password: "AdminPass!123" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "EMAIL_NOT_SUPPORTED");
  });

  test("email-as-username payload (with username field absent) still rejected as 400", async () => {
    // A payload that ONLY has email + password must be rejected as email use.
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email: "admin@example.com", password: "whatever" },
    });
    assert.equal(res.statusCode, 400);
  });

  test("wrong password → 401 INVALID_CREDENTIALS (unified with unknown user)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "WrongPass!999" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "INVALID_CREDENTIALS");
  });

  test("unknown username → 401 INVALID_CREDENTIALS (same code as wrong password)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "ghost", password: "Whatever!1" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "INVALID_CREDENTIALS");
  });

  test("inactive admin → 403 ACCOUNT_DISABLED", async () => {
    await seedAdmin(prisma, { username: "disabled", password: "AdminPass!123", role: "admin", isActive: false });
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "disabled", password: "AdminPass!123" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "ACCOUNT_DISABLED");
  });

  test("normalized username: login with 'ADMIN' matches stored 'admin'", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "  ADMIN  ", password: "AdminPass!123" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.admin.username, "admin");
  });

  test("normalized username: ' Alice ' and 'ALICE' are the same account", async () => {
    await seedAdmin(prisma, { username: "Alice", password: "AlicePass!1", role: "reviewer" });
    const resUpper = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "ALICE", password: "AlicePass!1" },
    });
    assert.equal(resUpper.statusCode, 200);
    const resSpaced = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "  alice ", password: "AlicePass!1" },
    });
    assert.equal(resSpaced.statusCode, 200);
  });

  test("GET /me with valid admin token returns the profile", async () => {
    // Login to get a token + cookie.
    const loginRes = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
    });
    const token = loginRes.json().data.token;
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.username, "admin");
    assert.equal(body.data.role, "admin");
  });

  test("GET /me without token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    assert.equal(res.statusCode, 401);
  });

  test("change-password success rotates sessionVersion and issues a fresh cookie", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
    });
    const oldToken = loginRes.json().data.token;

    const res = await app.inject({
      method: "POST",
      url: "/change-password",
      headers: { authorization: `Bearer ${oldToken}` },
      payload: { currentPassword: "AdminPass!123", newPassword: "NewPass!456" },
    });
    assert.equal(res.statusCode, 200, res.text);
    // New cookie issued.
    const setCookie = getSetCookies(res);
    assert.ok(setCookie[0].startsWith("mw_admin_token="));
  });

  test("old token is invalid after password change (sessionVersion mismatch → 401)", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
    });
    const oldToken = loginRes.json().data.token;

    await app.inject({
      method: "POST",
      url: "/change-password",
      headers: { authorization: `Bearer ${oldToken}` },
      payload: { currentPassword: "AdminPass!123", newPassword: "NewPass!456" },
    });

    // The OLD token now has a stale sessionVersion → /me must reject it.
    const meRes = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    assert.equal(meRes.statusCode, 401);
    assert.equal(meRes.json().error.code, "INVALID_TOKEN");
  });

  test("new password works for login after change; old password fails", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
    });
    const token = loginRes.json().data.token;
    await app.inject({
      method: "POST",
      url: "/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: "AdminPass!123", newPassword: "NewPass!456" },
    });

    const oldPwLogin = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
    });
    assert.equal(oldPwLogin.statusCode, 401);

    const newPwLogin = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "NewPass!456" },
    });
    assert.equal(newPwLogin.statusCode, 200);
  });

  test("change-password with wrong current password → 400 WRONG_PASSWORD", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
    });
    const token = loginRes.json().data.token;
    const res = await app.inject({
      method: "POST",
      url: "/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: "WrongCurrent!1", newPassword: "NewPass!456" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "WRONG_PASSWORD");
  });

  test("change-password without auth → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/change-password",
      payload: { currentPassword: "AdminPass!123", newPassword: "NewPass!456" },
    });
    assert.equal(res.statusCode, 401);
  });

  test("change-password rejects weak new password (422 VALIDATION_ERROR)", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
    });
    const token = loginRes.json().data.token;
    const res = await app.inject({
      method: "POST",
      url: "/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: "AdminPass!123", newPassword: "weak" },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, "VALIDATION_ERROR");
  });
});
