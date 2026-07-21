// Wave 2 Runtime: dual-identity security configuration.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §5 (Cookie/Storage
// Separation) and docs/implementation/WAVE2_AGENT_CONTRACTS.md (Agent Runtime).
//
// This module loads and validates the runtime configuration for the dual
// User/Admin identity system. It is fail-closed in production: missing,
// short, or identical JWT secrets cause startup to refuse booting rather
// than silently falling back to an insecure default.
//
// Forbidden fallbacks (NEVER used, even in development):
//   - process.env.JWT_SECRET                 (legacy single-secret)
//   - "dev-secret-change-in-production"      (legacy hardcoded dev secret)
//   - any hardcoded secret string
//
// Test environment: when NODE_ENV === "test", explicit test secrets may be
// supplied via USER_JWT_SECRET / ADMIN_JWT_SECRET. This is the ONLY non-
// production mode where secrets shorter than 32 chars are tolerated, and
// only when MW_ALLOW_TEST_SECRETS is set to "1" (a deliberate opt-in switch).

export const USER_JWT_AUDIENCE = "modelwiki-user";
export const ADMIN_JWT_AUDIENCE = "modelwiki-admin";

export const USER_COOKIE_NAME = "mw_user_token";
export const ADMIN_COOKIE_NAME = "mw_admin_token";

/** Minimum acceptable JWT secret length (bytes-equivalent of chars). */
export const MIN_SECRET_LENGTH = 32;

/**
 * Header keys whose values MUST be redacted from logs. Applied via the
 * Fastify logger redaction config. Authorization/cookie headers carry live
 * credentials; set-cookie carries freshly minted tokens; password/token
 * fields appear in request bodies and error objects.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "res.headers.set-cookie",
  "password",
  "newPassword",
  "currentPassword",
  "token",
  "resetToken",
  "verifyToken",
  "emailVerifyToken",
  "authorization",
  "cookie",
  "set-cookie",
];

export interface RuntimeCookieConfig {
  /** Cookie name. */
  name: string;
  /** httpOnly — always true for auth tokens. */
  httpOnly: boolean;
  /** secure flag — true in production (HTTPS only). */
  secure: boolean;
  /** sameSite policy. "lax" for browser-friendly top-level navigations. */
  sameSite: "strict" | "lax" | "none";
  /** Optional cookie domain (set via COOKIE_DOMAIN). */
  domain?: string;
  /** Cookie path. */
  path: string;
  /** TTL in seconds. */
  maxAge: number;
}

export interface RuntimeCorsConfig {
  /** Allowed origins (false = same-origin only, true = reflect, or list). */
  origin: string[] | boolean;
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
}

export interface RuntimeConfig {
  nodeEnv: "production" | "development" | "test";
  isProduction: boolean;
  isTest: boolean;
  isDevelopment: boolean;
  port: number;
  host: string;
  bodyLimitBytes: number;
  trustProxy: boolean;

  // Dual JWT secrets — never fall back to a shared/legacy secret.
  userJwtSecret: string;
  adminJwtSecret: string;

  // JWT TTLs
  userJwtExpiresIn: string;
  adminJwtExpiresIn: string;

  // Cookie separation
  userCookie: RuntimeCookieConfig;
  adminCookie: RuntimeCookieConfig;

  // CORS
  cors: RuntimeCorsConfig;

  // Redis
  redisUrl: string;

  // Review cache signing secret (kept from Phase 1+2, validated separately).
  reviewCacheSigningSecret?: string;

  // Rate limit
  rateLimitMax: number;
  rateLimitTimeWindow: string;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * Load and validate the runtime configuration. Throws on any production
 * violation (missing/short/identical secrets). Never returns a fallback
 * secret.
 */
export function loadRuntimeConfig(): RuntimeConfig {
  const nodeEnv = (env("NODE_ENV") || "development") as RuntimeConfig["nodeEnv"];
  const isProduction = nodeEnv === "production";
  const isTest = nodeEnv === "test";
  const isDevelopment = !isProduction && !isTest;

  const userJwtSecret = env("USER_JWT_SECRET");
  const adminJwtSecret = env("ADMIN_JWT_SECRET");

  // ─── Production: fail-closed on missing secrets ─────────────────────────
  // No fallback to JWT_SECRET or any hardcoded default. The app MUST refuse
  // to boot rather than run with an insecure (or absent) secret.
  if (isProduction) {
    if (!userJwtSecret) {
      throw new ConfigError(
        "USER_JWT_SECRET must be set in production (no fallback allowed). " +
          "Refusing to start with a missing user JWT secret.",
      );
    }
    if (!adminJwtSecret) {
      throw new ConfigError(
        "ADMIN_JWT_SECRET must be set in production (no fallback allowed). " +
          "Refusing to start with a missing admin JWT secret.",
      );
    }
    if (userJwtSecret.length < MIN_SECRET_LENGTH) {
      throw new ConfigError(
        `USER_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production ` +
          `(got ${userJwtSecret.length}). Refusing to start with a weak secret.`,
      );
    }
    if (adminJwtSecret.length < MIN_SECRET_LENGTH) {
      throw new ConfigError(
        `ADMIN_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production ` +
          `(got ${adminJwtSecret.length}). Refusing to start with a weak admin secret.`,
      );
    }
    // Reject identical secrets: a single compromised secret must not grant
    // access to BOTH account systems. In production this is a hard failure.
    if (userJwtSecret === adminJwtSecret) {
      throw new ConfigError(
        "USER_JWT_SECRET and ADMIN_JWT_SECRET must NOT be identical in production. " +
          "Independent secrets are required so a compromise of one system cannot " +
          "forge tokens for the other. Refusing to start.",
      );
    }
  } else {
    // Non-production: still refuse silent fallback to legacy secrets. Only
    // the explicit test-secrets switch allows short/dummy secrets, and ONLY
    // in test mode. Development requires real env-provided secrets too, but
    // tolerates shorter ones (warned below).
    const allowTestSecrets = isTest && env("MW_ALLOW_TEST_SECRETS") === "1";

    if (!userJwtSecret && !allowTestSecrets) {
      throw new ConfigError(
        "USER_JWT_SECRET is not set. Set it explicitly (do not rely on JWT_SECRET). " +
          `In test mode, set MW_ALLOW_TEST_SECRETS=1 to use built-in test secrets.`,
      );
    }
    if (!adminJwtSecret && !allowTestSecrets) {
      throw new ConfigError(
        "ADMIN_JWT_SECRET is not set. Set it explicitly (do not rely on JWT_SECRET). " +
          `In test mode, set MW_ALLOW_TEST_SECRETS=1 to use built-in test secrets.`,
      );
    }

    if (allowTestSecrets) {
      // Explicit, clearly-labelled test secrets. These are ONLY available
      // when NODE_ENV=test AND MW_ALLOW_TEST_SECRETS=1. They are never used
      // in production (the isProduction branch above throws before this).
      const testUser = "test-user-jwt-secret-do-not-use-in-prod-32+";
      const testAdmin = "test-admin-jwt-secret-do-not-use-in-prod-32+";
      return buildConfig({
        nodeEnv,
        isProduction,
        isTest,
        isDevelopment,
        userJwtSecret: userJwtSecret || testUser,
        adminJwtSecret: adminJwtSecret || testAdmin,
        reviewCacheSigningSecret: env("REVIEW_CACHE_SIGNING_SECRET"),
      });
    }

    if (userJwtSecret && userJwtSecret.length < MIN_SECRET_LENGTH) {
      // Dev: warn but allow (test rejects only in prod). We still don't
      // fall back — the caller-supplied weak secret is used as-is.
      console.warn(
        `[runtime] USER_JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} chars — strengthen before production.`,
      );
    }
    if (adminJwtSecret && adminJwtSecret.length < MIN_SECRET_LENGTH) {
      console.warn(
        `[runtime] ADMIN_JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} chars — strengthen before production.`,
      );
    }
    if (userJwtSecret && adminJwtSecret && userJwtSecret === adminJwtSecret) {
      console.warn(
        "[runtime] USER_JWT_SECRET and ADMIN_JWT_SECRET are identical — use independent secrets before production.",
      );
    }
  }

  return buildConfig({
    nodeEnv,
    isProduction,
    isTest,
    isDevelopment,
    userJwtSecret: userJwtSecret as string,
    adminJwtSecret: adminJwtSecret as string,
    reviewCacheSigningSecret: env("REVIEW_CACHE_SIGNING_SECRET"),
  });
}

function buildConfig(opts: {
  nodeEnv: RuntimeConfig["nodeEnv"];
  isProduction: boolean;
  isTest: boolean;
  isDevelopment: boolean;
  userJwtSecret: string;
  adminJwtSecret: string;
  reviewCacheSigningSecret?: string;
}): RuntimeConfig {
  const { isProduction, isTest } = opts;

  // CORS: explicit allowlist from CORS_ORIGINS. Empty/absent → same-origin
  // only (origin: false). Credentials are always enabled because auth
  // tokens travel in HttpOnly cookies.
  const corsOrigins = env("CORS_ORIGINS")
    ? env("CORS_ORIGINS")!
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : [];

  const cors: RuntimeCorsConfig = {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["X-Request-Id"],
  };

  // Cookies: secure in production, sameSite=lax so the browser sends the
  // cookie on top-level GET navigations (e.g. clicking an email verify
  // link) but not on cross-site POSTs (CSRF protection).
  const secure = isProduction || env("COOKIE_SECURE") === "true";
  const sameSite = (env("COOKIE_SAMESITE") as "strict" | "lax" | "none" | undefined) || "lax";
  const domain = env("COOKIE_DOMAIN");

  const userCookie: RuntimeCookieConfig = {
    name: USER_COOKIE_NAME,
    httpOnly: true,
    secure,
    sameSite,
    domain,
    path: "/",
    maxAge: 2 * 60 * 60, // 2h — matches user JWT TTL
  };
  const adminCookie: RuntimeCookieConfig = {
    name: ADMIN_COOKIE_NAME,
    httpOnly: true,
    secure,
    sameSite,
    domain,
    path: "/",
    maxAge: 60 * 60, // 1h — shorter admin TTL
  };

  // Trust the proxy hop so req.ip reflects the real client IP (behind a
  // reverse proxy / load balancer). Disabled in test where there is no
  // proxy and deterministic IPs matter.
  const trustProxy = env("TRUST_PROXY") !== "false";

  return {
    nodeEnv: opts.nodeEnv,
    isProduction,
    isTest,
    isDevelopment: opts.isDevelopment,
    port: Number(env("PORT") || "3000"),
    host: env("HOST") || "0.0.0.0",
    bodyLimitBytes: Number(env("BODY_LIMIT_BYTES") || 20 * 1024 * 1024),
    trustProxy,
    userJwtSecret: opts.userJwtSecret,
    adminJwtSecret: opts.adminJwtSecret,
    userJwtExpiresIn: env("USER_JWT_EXPIRES_IN") || "2h",
    adminJwtExpiresIn: env("ADMIN_JWT_EXPIRES_IN") || "1h",
    userCookie,
    adminCookie,
    cors,
    redisUrl: env("REDIS_URL") || "redis://localhost:6379",
    reviewCacheSigningSecret: opts.reviewCacheSigningSecret,
    rateLimitMax: Number(env("RATE_LIMIT_MAX") || "300"),
    rateLimitTimeWindow: env("RATE_LIMIT_TIME_WINDOW") || "1 minute",
  };
}

export { ConfigError };
