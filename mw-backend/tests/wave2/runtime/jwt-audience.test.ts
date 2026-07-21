// Wave 2 Runtime: dual JWT audience separation tests.
//
// Verifies the core identity-isolation invariant: a User token MUST NOT be
// accepted by the Admin verifier, and an Admin token MUST NOT be accepted by
// the User verifier. Two independent guarantees enforce this:
//   1. Different secrets → signature mismatch.
//   2. Different audiences (aud claim) → allowedAud rejection.
//
// Run: npx tsx --test tests/wave2/runtime/jwt-audience.test.ts

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";

import {
  buildUserJwtOptions,
  buildAdminJwtOptions,
  loadRuntimeConfig,
  USER_JWT_AUDIENCE,
  ADMIN_JWT_AUDIENCE,
} from "../../../src/runtime/index.js";

const USER_SECRET = "test-user-jwt-secret-for-audience-separation-32+";
const ADMIN_SECRET = "test-admin-jwt-secret-for-audience-separation-32+";

// Managed env (config reads process.env at call time).
const ENV_KEYS = ["NODE_ENV", "USER_JWT_SECRET", "ADMIN_JWT_SECRET", "MW_ALLOW_TEST_SECRETS"];
const saved: Record<string, string | undefined> = {};

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.NODE_ENV = "test";
  process.env.MW_ALLOW_TEST_SECRETS = "1";
  process.env.USER_JWT_SECRET = USER_SECRET;
  process.env.ADMIN_JWT_SECRET = ADMIN_SECRET;
});

after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function buildDualJwtApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const config = loadRuntimeConfig();
  await app.register(jwt, buildUserJwtOptions(config));
  await app.register(jwt, buildAdminJwtOptions(config));
  await app.ready();
  return app;
}

describe("dual JWT — audience separation", () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildDualJwtApp();
  });
  after(async () => {
    if (app) await app.close();
  });

  test("user token carries aud=modelwiki-user", () => {
    const token = (app as any).jwt.sign({ userId: "1" });
    const decoded = (app as any).jwt.decode(token);
    assert.equal(decoded.aud, USER_JWT_AUDIENCE);
  });

  test("admin token carries aud=modelwiki-admin", () => {
    const token = (app as any).jwt.admin.sign({ adminId: "1", role: "admin", sessionVersion: 0 });
    const decoded = (app as any).jwt.admin.decode(token);
    assert.equal(decoded.aud, ADMIN_JWT_AUDIENCE);
  });
});

describe("dual JWT — cross-token rejection", () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildDualJwtApp();
  });
  after(async () => {
    if (app) await app.close();
  });

  test("user token rejected by admin verifier (aud mismatch)", () => {
    const userToken = (app as any).jwt.sign({ userId: "1" });
    // app.jwt.admin.verify uses ADMIN secret + allowedAud=modelwiki-admin.
    // The user token is signed with USER secret (signature mismatch) AND
    // carries aud=modelwiki-user (audience mismatch). Either reason rejects.
    assert.throws(
      () => (app as any).jwt.admin.verify(userToken),
      (err: unknown) => err instanceof Error,
    );
  });

  test("admin token rejected by user verifier (aud mismatch)", () => {
    const adminToken = (app as any).jwt.admin.sign({ adminId: "1", role: "admin", sessionVersion: 0 });
    // user verifier uses USER secret + allowedAud=modelwiki-user.
    assert.throws(
      () => (app as any).jwt.verify(adminToken),
      (err: unknown) => err instanceof Error,
    );
  });

  test("user token verifies with user verifier", () => {
    const userToken = (app as any).jwt.sign({ userId: "1" });
    const payload = (app as any).jwt.verify(userToken);
    assert.equal(payload.userId, "1");
    assert.equal(payload.aud, USER_JWT_AUDIENCE);
  });

  test("admin token verifies with admin verifier", () => {
    const adminToken = (app as any).jwt.admin.sign({ adminId: "1", role: "admin", sessionVersion: 0 });
    const payload = (app as any).jwt.admin.verify(adminToken);
    assert.equal(payload.adminId, "1");
    assert.equal(payload.aud, ADMIN_JWT_AUDIENCE);
  });
});

describe("dual JWT — independent secrets", () => {
  test("secrets are different", () => {
    process.env.NODE_ENV = "test";
    process.env.MW_ALLOW_TEST_SECRETS = "1";
    process.env.USER_JWT_SECRET = USER_SECRET;
    process.env.ADMIN_JWT_SECRET = ADMIN_SECRET;
    const config = loadRuntimeConfig();
    assert.notEqual(config.userJwtSecret, config.adminJwtSecret);
  });

  test("admin namespace decorators exist on app.jwt.admin", async () => {
    const app = await buildDualJwtApp();
    try {
      assert.equal(typeof (app as any).jwt.admin.sign, "function");
      assert.equal(typeof (app as any).jwt.admin.verify, "function");
      assert.equal(typeof (app as any).jwt.admin.decode, "function");
    } finally {
      await app.close();
    }
  });
});
