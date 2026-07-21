// Admin login rate-limit tests: namespace isolation, threshold, per-IP.
//
// Contract: AUTH_ACCOUNT_CONTRACT.md §3.1 + §5.
//   - Limit: 5 attempts per minute per IP.
//   - Namespace: rate-limit:admin:login:<ip>  (separate from User's rate-limit:user:*)
//
// Run: npx tsx --test tests/wave2/admin-auth/rate-limit.test.ts

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
import { adminLoginRateKey, ADMIN_LOGIN_RATE_LIMIT, ADMIN_LOGIN_RATE_WINDOW_SECONDS } from "../../../src/services/admin-auth/rateLimit.js";
import { ADMIN_LOGIN_RATE_LIMIT_PREFIX } from "../../../src/plugins/admin-auth/constants.js";

describe("admin login rate-limit namespace isolation", () => {
  test("adminLoginRateKey produces the correct isolated namespace", () => {
    const key = adminLoginRateKey("1.2.3.4");
    assert.equal(key, "rate-limit:admin:login:1.2.3.4");
    // Must NOT collide with the User login namespace.
    assert.ok(!key.startsWith("rate-limit:user:"));
    assert.ok(key.startsWith(ADMIN_LOGIN_RATE_LIMIT_PREFIX));
  });

  test("admin and user rate-limit keys are in different namespaces", () => {
    const adminKey = adminLoginRateKey("10.0.0.1");
    const userKey = `rate-limit:user:login:10.0.0.1`;
    assert.notEqual(adminKey, userKey);
    assert.ok(adminKey.startsWith("rate-limit:admin:"));
    assert.ok(userKey.startsWith("rate-limit:user:"));
  });

  test("ADMIN_LOGIN_RATE_LIMIT is 5 and window is 60 seconds (contract §3.1)", () => {
    assert.equal(ADMIN_LOGIN_RATE_LIMIT, 5);
    assert.equal(ADMIN_LOGIN_RATE_WINDOW_SECONDS, 60);
  });
});

describe("admin login rate-limit enforcement via /login", () => {
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

  test("5 failed attempts succeed (401), 6th is rate-limited (429)", async () => {
    const payload = { username: "admin", password: "WrongPass!99" };
    // 5 attempts → all 401 (wrong password, but under the limit).
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/login", payload });
      assert.equal(res.statusCode, 401, `attempt ${i + 1} should be 401 not rate-limited`);
    }
    // 6th attempt → 429 RATE_LIMITED.
    const res = await app.inject({ method: "POST", url: "/login", payload });
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error.code, "RATE_LIMITED");
  });

  test("rate-limit is per-IP: a different IP is not affected", async () => {
    const payload = { username: "admin", password: "WrongPass!99" };
    // Exhaust the limit from IP 1.
    for (let i = 0; i < 6; i++) {
      await app.inject({
        method: "POST",
        url: "/login",
        payload,
        headers: { "x-forwarded-for": "1.1.1.1" },
      });
    }
    // A different IP should still be able to attempt (and get 401, not 429).
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload,
      headers: { "x-forwarded-for": "2.2.2.2" },
    });
    assert.equal(res.statusCode, 401);
    assert.notEqual(res.json().error.code, "RATE_LIMITED");
  });

  test("successful login still counts against the rate-limit", async () => {
    // The rate limiter increments BEFORE password verification, so even
    // successful logins consume the budget. 5 successful logins → 6th is 429.
    const payload = { username: "admin", password: "AdminPass!123" };
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/login", payload });
      assert.equal(res.statusCode, 200, `successful login ${i + 1} should work`);
    }
    const res = await app.inject({ method: "POST", url: "/login", payload });
    assert.equal(res.statusCode, 429);
  });

  test("Redis mock correctly tracks the counter key and TTL", async () => {
    const ip = "9.9.9.9";
    const payload = { username: "admin", password: "WrongPass!1" };
    await app.inject({
      method: "POST",
      url: "/login",
      payload,
      headers: { "x-forwarded-for": ip },
    });
    const key = adminLoginRateKey(ip);
    const count = redis._counts.get(key);
    assert.equal(count, 1);
    const ttl = redis._ttls.get(key);
    assert.equal(ttl, ADMIN_LOGIN_RATE_WINDOW_SECONDS);
  });
});
