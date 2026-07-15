import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fsp from "fs/promises";
import sharp from "sharp";
import path from "path";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { figureRoutes } from "./routes/figures.js";
import { searchRoutes } from "./routes/search.js";
import { categoryRoutes } from "./routes/categories.js";
import { seriesRoutes } from "./routes/series.js";
import { manufacturerRoutes } from "./routes/manufacturer.js";
import { sculptorRoutes } from "./routes/sculptor.js";
import { characterRoutes } from "./routes/characters.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { adminAuthRoutes } from "./routes/admin-auth.js";
import { imageRoutes } from "./routes/images.js";
import { communityRoutes } from "./routes/community.js";
import Redis from "ioredis";
import { installRedisFlushGuard } from "./security/redisGuard.js";
import { registerBigIntSerializer } from "./plugins/bigintSerializer.js";
import { registerReadinessRoutes } from "./plugins/readiness.js";

// Wave 2 dual-identity runtime: configuration, dual JWT factory, identity
// collision guard, and graceful shutdown manager.
import {
  loadRuntimeConfig,
  buildUserJwtOptions,
  buildAdminJwtOptions,
  registerIdentityCollisionGuard,
  createShutdownManager,
  LOG_REDACT_PATHS,
} from "./runtime/index.js";

import { adminGuard } from "./plugins/adminGuard.js";
import { verifyAdminIdentity } from "./plugins/admin-auth/guard.js";

async function main() {
  // ─── Load + validate runtime config (fail-closed on bad secrets) ────────
  // Throws before any resource is opened if production secrets are missing,
  // short, or identical. Never falls back to JWT_SECRET / dev-secret.
  const config = loadRuntimeConfig();
  const isProduction = config.isProduction;

  const app = Fastify({
    logger: {
      // Redact credentials from logs. JWTs, cookies, passwords, and tokens
      // are replaced with [REDACTED] at the pino serialization layer so they
      // never appear in log output (contract: "DO NOT log JWT").
      redact: {
        paths: [...LOG_REDACT_PATHS],
        censor: "[REDACTED]",
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    // Propagate an inbound X-Request-Id or generate one per request.
    requestIdHeader: "x-request-id",
  });
  const prisma = new PrismaClient();
  const redis = new Redis(config.redisUrl);

  // Phase 1+2 runtime-security: REVIEW_CACHE_SIGNING_SECRET must be set in
  // production. The cached review-image endpoint signs URLs with an HMAC
  // using this secret. Without it, either the endpoint must be disabled or
  // a fallback secret would be used — both unacceptable. Refuse to start.
  if (isProduction && !config.reviewCacheSigningSecret) {
    throw new Error("REVIEW_CACHE_SIGNING_SECRET must be set in production (no fallback allowed)");
  }
  if (config.reviewCacheSigningSecret && config.reviewCacheSigningSecret.length < 32) {
    if (isProduction) {
      throw new Error("REVIEW_CACHE_SIGNING_SECRET must be at least 32 characters in production");
    }
    app.log.warn("REVIEW_CACHE_SIGNING_SECRET is shorter than 32 characters — set a stronger secret before production");
  }

  app.decorate("prisma", prisma);
  app.decorate("redis", redis);

  // Phase 1+2 runtime-security: install FLUSHDB/FLUSHALL guard on the Redis
  // client. Contract §14: "FLUSHDB / FLUSHALL are forbidden everywhere; the
  // codebase MUST NOT call them, and a runtime guard MUST reject any attempt."
  installRedisFlushGuard(redis);

  // BigInt → string serialization (preserves full precision for any ID size).
  registerBigIntSerializer(app);

  // /health (liveness) and /ready (readiness: PG + Redis).
  registerReadinessRoutes(app);

  // ─── CORS (explicit allowlist, credentials for HttpOnly cookies) ──────────
  await app.register(cors, {
    origin: config.cors.origin,
    methods: config.cors.methods,
    allowedHeaders: config.cors.allowedHeaders,
    exposedHeaders: config.cors.exposedHeaders,
    credentials: config.cors.credentials,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        imgSrc: ["'self'", "data:", "https:"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
    },
    frameguard: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
  });

  // ─── Dual JWT registration ───────────────────────────────────────────────
  // User identity: default namespace (app.jwt) with USER_JWT_SECRET and
  // aud=modelwiki-user. Admin identity: namespace "admin" (app.adminJwt*)
  // with ADMIN_JWT_SECRET and aud=modelwiki-admin.
  //
  // Two independent guarantees prevent cross-system token acceptance:
  //   1. Different secrets → signature mismatch on cross-verification.
  //   2. Different audiences → verify rejects even if secrets matched.
  await app.register(jwt, buildUserJwtOptions(config));
  await app.register(jwt, buildAdminJwtOptions(config));

  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitTimeWindow,
    keyGenerator: (req) => req.ip,
  });

  // ─── Identity collision guard ─────────────────────────────────────────────
  // A request MUST NOT carry both req.user and req.admin. This runs as a
  // global preHandler and rejects dual-identity requests with 400 before any
  // route handler executes.
  registerIdentityCollisionGuard(app);

  app.addHook("onRequest", async (req, reply) => {
    const urlPath = req.url;
    const isAdminPath = urlPath.startsWith("/api/v1/admin");
    const isAuthPath = urlPath.startsWith("/api/v1/auth");
    if (isAdminPath || isAuthPath) {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    }
    // Wave 2: Admin route protection.
    // /api/v1/admin/auth/login is public (no guard).
    // All other /api/v1/admin/** routes require AdminAccount identity.
    const isAdminAuthLoginPath = urlPath.startsWith("/api/v1/admin/auth/login");
    if (isAdminPath && !isAdminAuthLoginPath) {
      const ok = await verifyAdminIdentity(app as any, req as any, reply as any);
      if (!ok) return;
    }
    // NOTE: the old ambiguous admin判断 that queried the User table for
    // admin role has been removed. Admin routes are now guarded by the
    // dedicated `adminGuard` middleware (mounted by the Integrator on
    // /api/v1/admin/** — see Integrator mount points below). User-protected
    // routes use `userGuard`. Both guards verify their respective JWT
    // audiences and re-query the DB; neither trusts the other's tokens.
  });

  app.register(imageRoutes, { prefix: "/api/v1/figures/images" });
  app.register(figureRoutes, { prefix: "/api/v1/figures" });
  app.register(searchRoutes, { prefix: "/api/v1/search" });
  app.register(categoryRoutes, { prefix: "/api/v1/categories" });
  app.register(seriesRoutes, { prefix: "/api/v1/series" });
  app.register(manufacturerRoutes, { prefix: "/api/v1/manufacturers" });
  app.register(sculptorRoutes, { prefix: "/api/v1/sculptors" });
  app.register(characterRoutes, { prefix: "/api/v1/characters" });
  // Serve cached review candidate images (no auth — URL is opaque)
  app.get("/api/v1/review/cached-image/:reviewId/:fileName", async (req: any, reply: any) => {
    const { reviewId, fileName } = req.params as any;
    try {
      if (!/^[a-zA-Z0-9_-]+$/.test(reviewId) || !/^[a-f0-9]{64}\.[a-z]+$/i.test(fileName)) {
        return reply.status(404).send({ success: false, error: { code: "NOT_FOUND" } });
      }
      const signingSecret = config.reviewCacheSigningSecret;
      if (!signingSecret) {
        // In production this is unreachable — startup check refuses to boot.
        app.log.error("REVIEW_CACHE_SIGNING_SECRET missing at request time");
        return reply.status(500).send({ success: false, error: { code: "SIGNING_NOT_CONFIGURED" } });
      }
      // Signature validation
      const qExp = (req.query as any).exp;
      const qSig = (req.query as any).sig;
      if (!qExp || !qSig) {
        return reply.status(403).send({ success: false, error: { code: "ACCESS_DENIED" } });
      }
      const expInt = parseInt(qExp, 10);
      if (isNaN(expInt) || Date.now() > expInt) {
        return reply.status(403).send({ success: false, error: { code: "ACCESS_DENIED" } });
      }
      const maxTtl = 86400000;
      if (expInt > Date.now() + maxTtl) {
        return reply.status(403).send({ success: false, error: { code: "ACCESS_DENIED" } });
      }
      const signPayload = `${reviewId}/${fileName}:${qExp}`;
      const expectedSig = crypto.createHmac("sha256", signingSecret).update(signPayload).digest("hex");
      // timingSafeEqual to prevent timing attacks
      if (qSig.length !== expectedSig.length) {
        return reply.status(403).send({ success: false, error: { code: "ACCESS_DENIED" } });
      }
      if (!crypto.timingSafeEqual(Buffer.from(qSig), Buffer.from(expectedSig))) {
        return reply.status(403).send({ success: false, error: { code: "ACCESS_DENIED" } });
      }
      const REVIEW_CACHE_DIR = process.env.REVIEW_CACHE_DIR || "/app/assets/review-cache";
      const filePath = path.join(REVIEW_CACHE_DIR, reviewId, fileName);
      let fileBuf: Buffer;
      try {
        fileBuf = await fsp.readFile(filePath);
      } catch {
        return reply.status(404).send({ success: false, error: { code: "NOT_FOUND" } });
      }
      let ct = "image/jpeg";
      try {
        const meta = await sharp(fileBuf).metadata();
        if (meta.format === "png") ct = "image/png";
        else if (meta.format === "webp") ct = "image/webp";
        else if (meta.format === "jpeg") ct = "image/jpeg";
      } catch {}
      reply.header("Content-Type", ct);
      reply.header("Cache-Control", "private, max-age=86400");
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(fileBuf);
    } catch {
      return reply.status(404).send({ success: false, error: { code: "NOT_FOUND" } });
    }
  });

  // ─── Route mounting ───────────────────────────────────────────────────────
  // Integrator mount points (completed after User/Admin auth agents merge):
  //
  //   1. authRoutes        — already mounted below (User Auth Agent owns it).
  //   2. adminAuthRoutes   — mount at /api/v1/admin/auth (Admin Auth Agent).
  //                          Import from "./routes/admin-auth.js" once it exists.
  //   3. userGuard         — apply to user-protected routes (User Auth Agent).
  //                          Import from "./plugins/user-auth/userGuard.js".
  //   4. adminGuard        — apply to /api/v1/admin/** routes (Admin Auth Agent).
  //                          Import from "./plugins/adminGuard.js" (rewritten).
  //
  // The Runtime branch does NOT import adminAuthRoutes/userGuard/adminGuard
  // (they do not exist yet) to keep the build green. The Integrator adds
  // these imports and wires the guards onto the appropriate route prefixes.
  app.register(adminRoutes, { prefix: "/api/v1/admin" });
  app.register(authRoutes, { prefix: "/api/v1/auth" });
  // Wave 2: Admin auth routes (public login, guarded logout/change-password/me)
  app.register(adminAuthRoutes, { prefix: "/api/v1/admin/auth" });
  app.register(communityRoutes, { prefix: "/api/v1" });

  // ─── Sanitized error handler ──────────────────────────────────────────────
  // In production, never leak internal file paths, DNS details, stack traces,
  // or raw error messages to the client. Client errors (4xx) return the
  // error code only; server errors (5xx) return a generic code.
  app.setErrorHandler((error: any, req: any, reply: any) => {
    if (error?.name === "ZodError" || Array.isArray(error?.issues)) {
      return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", details: error.issues || error.errors } });
    }
    if (error.validation) return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", details: error.validation } });
    if (error.statusCode === 429) return reply.status(429).send({ success: false, error: { code: "RATE_LIMITED" } });
    if (error.statusCode && error.statusCode < 500) {
      const code = error.code || "BAD_REQUEST";
      const message = isProduction ? undefined : error.message;
      return reply.status(error.statusCode).send({
        success: false,
        error: message ? { code, message } : { code },
      });
    }
    app.log.error(error);
    reply.status(500).send({ success: false, error: { code: "INTERNAL_ERROR" } });
  });

  // ─── Graceful shutdown ───────────────────────────────────────────────────
  // Idempotent + timeout-bounded. On SIGTERM/SIGINT: close HTTP server,
  // disconnect Prisma, quit Redis. A second shutdown call is a no-op.
  const shutdownManager = createShutdownManager({
    app,
    prisma,
    redis,
    timeoutMs: 30_000,
  });

  process.on("SIGTERM", () => void shutdownManager.shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdownManager.shutdown("SIGINT"));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    // Release any partially-opened resources before exiting.
    try {
      await shutdownManager.shutdown("STARTUP_FAILURE");
    } catch {
      // best-effort cleanup
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
