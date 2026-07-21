// Wave 2 Runtime config tests.
//
// Verifies fail-closed behavior for production secrets, no fallback to
// legacy JWT_SECRET / dev-secret, test-mode test secrets, cookie separation,
// and log redaction paths.
//
// Run: npx tsx --test tests/wave2/runtime/config.test.ts

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  loadRuntimeConfig,
  ConfigError,
  USER_JWT_AUDIENCE,
  ADMIN_JWT_AUDIENCE,
  USER_COOKIE_NAME,
  ADMIN_COOKIE_NAME,
  MIN_SECRET_LENGTH,
  LOG_REDACT_PATHS,
} from "../../../src/runtime/index.js";

// Env vars managed by these tests. Saved/restored around each case so tests
// are hermetic and do not leak state to other test files.
const MANAGED = [
  "NODE_ENV",
  "USER_JWT_SECRET",
  "ADMIN_JWT_SECRET",
  "MW_ALLOW_TEST_SECRETS",
  "JWT_SECRET",
  "CORS_ORIGINS",
  "COOKIE_DOMAIN",
  "COOKIE_SECURE",
  "COOKIE_SAMESITE",
  "TRUST_PROXY",
  "REDIS_URL",
  "REVIEW_CACHE_SIGNING_SECRET",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of MANAGED) saved[k] = process.env[k];
  // default to a clean state
  delete process.env.NODE_ENV;
  delete process.env.USER_JWT_SECRET;
  delete process.env.ADMIN_JWT_SECRET;
  delete process.env.MW_ALLOW_TEST_SECRETS;
  delete process.env.JWT_SECRET;
});

afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const STRONG = "a-very-strong-user-jwt-secret-32-chars-min!!";
const STRONG2 = "a-very-strong-admin-jwt-secret-32-chars-min!";

describe("runtime config — production fail-closed", () => {
  test("missing USER_JWT_SECRET in production → throws", () => {
    process.env.NODE_ENV = "production";
    process.env.ADMIN_JWT_SECRET = STRONG2;
    assert.throws(() => loadRuntimeConfig(), /USER_JWT_SECRET must be set in production/);
  });

  test("missing ADMIN_JWT_SECRET in production → throws", () => {
    process.env.NODE_ENV = "production";
    process.env.USER_JWT_SECRET = STRONG;
    assert.throws(() => loadRuntimeConfig(), /ADMIN_JWT_SECRET must be set in production/);
  });

  test("short USER_JWT_SECRET in production → throws", () => {
    process.env.NODE_ENV = "production";
    process.env.USER_JWT_SECRET = "too-short";
    process.env.ADMIN_JWT_SECRET = STRONG2;
    assert.throws(
      () => loadRuntimeConfig(),
      new RegExp(`USER_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`),
    );
  });

  test("short ADMIN_JWT_SECRET in production → throws", () => {
    process.env.NODE_ENV = "production";
    process.env.USER_JWT_SECRET = STRONG;
    process.env.ADMIN_JWT_SECRET = "too-short";
    assert.throws(
      () => loadRuntimeConfig(),
      new RegExp(`ADMIN_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`),
    );
  });

  test("identical secrets in production → throws", () => {
    process.env.NODE_ENV = "production";
    process.env.USER_JWT_SECRET = STRONG;
    process.env.ADMIN_JWT_SECRET = STRONG; // identical
    assert.throws(() => loadRuntimeConfig(), /must NOT be identical/);
  });

  test("valid independent secrets in production → returns config", () => {
    process.env.NODE_ENV = "production";
    process.env.USER_JWT_SECRET = STRONG;
    process.env.ADMIN_JWT_SECRET = STRONG2;
    process.env.REVIEW_CACHE_SIGNING_SECRET = "x".repeat(32);
    const cfg = loadRuntimeConfig();
    assert.equal(cfg.userJwtSecret, STRONG);
    assert.equal(cfg.adminJwtSecret, STRONG2);
    assert.equal(cfg.isProduction, true);
    assert.notEqual(cfg.userJwtSecret, cfg.adminJwtSecret);
  });

  test("no fallback to JWT_SECRET in production", () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = STRONG; // legacy — must NOT be used
    // USER_JWT_SECRET / ADMIN_JWT_SECRET absent
    assert.throws(() => loadRuntimeConfig(), /USER_JWT_SECRET must be set/);
  });

  test("no fallback to dev-secret hardcoded string", () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "dev-secret-change-in-production";
    assert.throws(() => loadRuntimeConfig(), /USER_JWT_SECRET must be set/);
  });
});

describe("runtime config — test mode", () => {
  test("MW_ALLOW_TEST_SECRETS=1 allows missing secrets in test", () => {
    process.env.NODE_ENV = "test";
    process.env.MW_ALLOW_TEST_SECRETS = "1";
    const cfg = loadRuntimeConfig();
    assert.equal(cfg.isTest, true);
    assert.ok(cfg.userJwtSecret.length >= MIN_SECRET_LENGTH);
    assert.ok(cfg.adminJwtSecret.length >= MIN_SECRET_LENGTH);
    assert.notEqual(cfg.userJwtSecret, cfg.adminJwtSecret);
  });

  test("test mode without MW_ALLOW_TEST_SECRETS → throws (no silent fallback)", () => {
    process.env.NODE_ENV = "test";
    // no secrets, no allow switch
    assert.throws(() => loadRuntimeConfig(), /USER_JWT_SECRET is not set/);
  });

  test("test mode does not fall back to JWT_SECRET", () => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = STRONG;
    assert.throws(() => loadRuntimeConfig(), /USER_JWT_SECRET is not set/);
  });

  test("test mode with explicit secrets uses them (ignores allow switch)", () => {
    process.env.NODE_ENV = "test";
    process.env.MW_ALLOW_TEST_SECRETS = "1";
    process.env.USER_JWT_SECRET = "my-explicit-test-user-secret-32-chars";
    process.env.ADMIN_JWT_SECRET = "my-explicit-test-admin-secret-32-chars";
    const cfg = loadRuntimeConfig();
    assert.equal(cfg.userJwtSecret, "my-explicit-test-user-secret-32-chars");
    assert.equal(cfg.adminJwtSecret, "my-explicit-test-admin-secret-32-chars");
  });
});

describe("runtime config — cookie separation", () => {
  test("user and admin cookies have distinct names", () => {
    process.env.NODE_ENV = "test";
    process.env.MW_ALLOW_TEST_SECRETS = "1";
    const cfg = loadRuntimeConfig();
    assert.equal(cfg.userCookie.name, USER_COOKIE_NAME);
    assert.equal(cfg.adminCookie.name, ADMIN_COOKIE_NAME);
    assert.equal(USER_COOKIE_NAME, "mw_user_token");
    assert.equal(ADMIN_COOKIE_NAME, "mw_admin_token");
    assert.notEqual(cfg.userCookie.name, cfg.adminCookie.name);
  });

  test("cookies are httpOnly", () => {
    process.env.NODE_ENV = "test";
    process.env.MW_ALLOW_TEST_SECRETS = "1";
    const cfg = loadRuntimeConfig();
    assert.equal(cfg.userCookie.httpOnly, true);
    assert.equal(cfg.adminCookie.httpOnly, true);
  });

  test("cookies are secure in production", () => {
    process.env.NODE_ENV = "production";
    process.env.USER_JWT_SECRET = STRONG;
    process.env.ADMIN_JWT_SECRET = STRONG2;
    process.env.REVIEW_CACHE_SIGNING_SECRET = "x".repeat(32);
    const cfg = loadRuntimeConfig();
    assert.equal(cfg.userCookie.secure, true);
    assert.equal(cfg.adminCookie.secure, true);
  });

  test("sameSite defaults to lax", () => {
    process.env.NODE_ENV = "test";
    process.env.MW_ALLOW_TEST_SECRETS = "1";
    const cfg = loadRuntimeConfig();
    assert.equal(cfg.userCookie.sameSite, "lax");
    assert.equal(cfg.adminCookie.sameSite, "lax");
  });

  test("COOKIE_DOMAIN is propagated", () => {
    process.env.NODE_ENV = "test";
    process.env.MW_ALLOW_TEST_SECRETS = "1";
    process.env.COOKIE_DOMAIN = ".example.com";
    const cfg = loadRuntimeConfig();
    assert.equal(cfg.userCookie.domain, ".example.com");
    assert.equal(cfg.adminCookie.domain, ".example.com");
  });
});

describe("runtime config — JWT audience constants", () => {
  test("user and admin audiences are distinct", () => {
    assert.equal(USER_JWT_AUDIENCE, "modelwiki-user");
    assert.equal(ADMIN_JWT_AUDIENCE, "modelwiki-admin");
    assert.notEqual(USER_JWT_AUDIENCE, ADMIN_JWT_AUDIENCE);
  });
});

describe("runtime config — log redaction", () => {
  test("authorization header is redacted", () => {
    assert.ok(LOG_REDACT_PATHS.some((p) => p.includes("authorization")));
  });

  test("cookie header is redacted", () => {
    assert.ok(LOG_REDACT_PATHS.some((p) => p.includes("cookie")));
  });

  test("set-cookie is redacted", () => {
    assert.ok(LOG_REDACT_PATHS.some((p) => p.includes("set-cookie")));
  });

  test("password fields are redacted", () => {
    assert.ok(LOG_REDACT_PATHS.includes("password"));
    assert.ok(LOG_REDACT_PATHS.includes("newPassword"));
    assert.ok(LOG_REDACT_PATHS.includes("currentPassword"));
  });

  test("token fields are redacted", () => {
    assert.ok(LOG_REDACT_PATHS.includes("token"));
    assert.ok(LOG_REDACT_PATHS.includes("resetToken"));
  });
});

describe("runtime config — CORS", () => {
  test("CORS_ORIGINS parsed into allowlist", () => {
    process.env.NODE_ENV = "test";
    process.env.MW_ALLOW_TEST_SECRETS = "1";
    process.env.CORS_ORIGINS = "https://a.test, https://b.test";
    const cfg = loadRuntimeConfig();
    assert.deepEqual(cfg.cors.origin, ["https://a.test", "https://b.test"]);
    assert.equal(cfg.cors.credentials, true);
  });

  test("no CORS_ORIGINS → same-origin only (false)", () => {
    process.env.NODE_ENV = "test";
    process.env.MW_ALLOW_TEST_SECRETS = "1";
    const cfg = loadRuntimeConfig();
    assert.equal(cfg.cors.origin, false);
  });
});

describe("runtime config — ConfigError type", () => {
  test("thrown errors are ConfigError instances", () => {
    process.env.NODE_ENV = "production";
    assert.throws(
      () => loadRuntimeConfig(),
      (err: unknown) => err instanceof Error && err.name === "ConfigError",
    );
  });
});
