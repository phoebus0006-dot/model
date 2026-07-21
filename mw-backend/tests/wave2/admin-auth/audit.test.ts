// Admin audit log tests: verify that login_success, login_failed, logout,
// password_changed, create_admin, account_disabled, and token_rejected
// events are written to AdminAuditLog with the correct fields.
//
// Contract: AUTH_ACCOUNT_CONTRACT.md §3.3 + §6.
// The AdminAuditLog schema has NO metadata column — all context is carried
// in the defined string columns. These tests assert that no `metadata` field
// is ever written.
//
// Run: npx tsx --test tests/wave2/admin-auth/audit.test.ts

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import {
  buildApp,
  makePrismaMock,
  makeRedisMock,
  seedAdmin,
  type PrismaMock,
  type RedisMock,
} from "./helpers.js";
import { createAdmin } from "../../../src/services/admin-auth/createAdmin.js";

describe("admin audit log: login events", () => {
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

  test("successful login writes an audit row with action=login_success", async () => {
    await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
    });
    const logs = prisma._auditLogs.filter((l) => l.action === "login_success");
    assert.equal(logs.length, 1);
    const entry = logs[0];
    assert.equal(entry.targetType, "admin");
    assert.ok(entry.targetId, "targetId should be set");
    assert.ok(entry.actorAdminId, "actorAdminId should be set");
    // No metadata field (schema does not have one).
    assert.equal(entry.metadata, undefined);
  });

  test("failed login (wrong password) writes an audit row with action=login_failed", async () => {
    await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "WrongPass!99" },
    });
    const logs = prisma._auditLogs.filter((l) => l.action === "login_failed");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].targetType, "admin");
  });

  test("failed login against unknown username does NOT write an audit row (FK constraint)", async () => {
    await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "ghost", password: "Whatever!1" },
    });
    // No audit row can be written because there is no AdminAccount to
    // satisfy the actorAdminId FK constraint.
    const logs = prisma._auditLogs.filter((l) => l.action === "login_failed");
    assert.equal(logs.length, 0);
  });

  test("login against disabled account writes login_failed audit row", async () => {
    await seedAdmin(prisma, { username: "disabled", password: "AdminPass!123", role: "admin", isActive: false });
    await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "disabled", password: "AdminPass!123" },
    });
    const logs = prisma._auditLogs.filter((l) => l.action === "login_failed");
    assert.equal(logs.length, 1);
  });
});

describe("admin audit log: logout + password change events", () => {
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

  test("logout writes an audit row with action=logout", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
    });
    const token = loginRes.json().data.token;
    await app.inject({
      method: "POST",
      url: "/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    const logs = prisma._auditLogs.filter((l) => l.action === "logout");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].targetType, "admin");
  });

  test("password change writes an audit row with action=password_changed", async () => {
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
    const logs = prisma._auditLogs.filter((l) => l.action === "password_changed");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].targetType, "admin");
    // No metadata field.
    assert.equal(logs[0].metadata, undefined);
  });
});

describe("admin audit log: account_disabled + token_rejected events", () => {
  let app: FastifyInstance;
  let prisma: PrismaMock;
  let redis: RedisMock;

  beforeEach(async () => {
    prisma = makePrismaMock();
    redis = makeRedisMock();
    app = await buildApp(prisma, redis);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  test("disabled admin using old token writes account_disabled audit row", async () => {
    const id = await seedAdmin(prisma, { username: "active", password: "ActivePass!1", role: "admin" });
    const loginRes = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "active", password: "ActivePass!1" },
    });
    const token = loginRes.json().data.token;

    // Disable in DB.
    const row = prisma._admins.get(id);
    assert.ok(row);
    row.isActive = false;

    // Use the old token → guard detects disabled, writes account_disabled audit.
    await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    const logs = prisma._auditLogs.filter((l) => l.action === "account_disabled");
    assert.equal(logs.length, 1);
  });

  test("stale token (sessionVersion mismatch) writes token_rejected audit row", async () => {
    const id = await seedAdmin(prisma, { username: "stale", password: "StalePass!1", role: "admin" });
    const loginRes = await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "stale", password: "StalePass!1" },
    });
    const token = loginRes.json().data.token;

    // Bump sessionVersion in DB (simulates a password change on another client).
    const row = prisma._admins.get(id);
    assert.ok(row);
    row.sessionVersion = 99;

    // Old token → guard detects mismatch, writes token_rejected audit.
    await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    const logs = prisma._auditLogs.filter((l) => l.action === "token_rejected");
    assert.equal(logs.length, 1);
  });
});

describe("admin audit log: create_admin event", () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  test("createAdmin writes an audit row with action=create_admin", async () => {
    await createAdmin(prisma, {
      username: "newadmin",
      displayName: "New Admin",
      role: "admin",
      password: "NewAdminPass!1",
    });
    const logs = prisma._auditLogs.filter((l) => l.action === "create_admin");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].targetType, "admin");
    assert.ok(logs[0].actorAdminId, "actorAdminId should be the new admin's own id");
  });
});

describe("admin audit log: schema field compliance", () => {
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

  test("audit entries only use schema-defined columns (no metadata, no extra fields)", async () => {
    await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
    });
    const entry = prisma._auditLogs[0];
    const allowedKeys = new Set([
      "actorAdminId",
      "action",
      "targetType",
      "targetId",
      "requestId",
      "ip",
      "userAgent",
    ]);
    for (const key of Object.keys(entry)) {
      assert.ok(allowedKeys.has(key), `audit entry has unexpected field "${key}"`);
    }
  });

  test("audit entry captures ip and userAgent from the request", async () => {
    await app.inject({
      method: "POST",
      url: "/login",
      payload: { username: "admin", password: "AdminPass!123" },
      headers: {
        "x-forwarded-for": "5.5.5.5",
        "user-agent": "TestAgent/1.0",
      },
    });
    const entry = prisma._auditLogs[0];
    assert.equal(entry.ip, "5.5.5.5");
    assert.equal(entry.userAgent, "TestAgent/1.0");
  });
});
