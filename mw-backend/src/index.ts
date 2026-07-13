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
import { imageRoutes } from "./routes/images.js";
import { communityRoutes } from "./routes/community.js";
import Redis from "ioredis";
import { installRedisFlushGuard } from "./security/redisGuard.js";
import { registerBigIntSerializer } from "./plugins/bigintSerializer.js";
import { registerReadinessRoutes } from "./plugins/readiness.js";
import { verifyUserFromDb, ROLE_ADMIN } from "./plugins/adminGuard.js";

async function main() {
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 20 * 1024 * 1024) });
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  const jwtSecret = process.env.JWT_SECRET || "dev-secret-change-in-production";
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction && (!process.env.JWT_SECRET || jwtSecret === "dev-secret-change-in-production" || jwtSecret.length < 32)) {
    throw new Error("JWT_SECRET must be set to a strong secret in production");
  }

  // Phase 1+2 runtime-security: REVIEW_CACHE_SIGNING_SECRET must be set in
  // production. The cached review-image endpoint signs URLs with an HMAC
  // using this secret. Without it, either the endpoint must be disabled or
  // a fallback secret would be used — both unacceptable. Refuse to start.
  if (isProduction && !process.env.REVIEW_CACHE_SIGNING_SECRET) {
    throw new Error("REVIEW_CACHE_SIGNING_SECRET must be set in production (no fallback allowed)");
  }
  if (process.env.REVIEW_CACHE_SIGNING_SECRET && process.env.REVIEW_CACHE_SIGNING_SECRET.length < 32) {
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
  // This blocks both direct method calls (redis.flushdb()) and raw
  // sendCommand({ name: "FLUSHDB" }) calls. Non-removable once installed.
  installRedisFlushGuard(redis);

  // Phase 1+2 runtime-security: BigInt → string serialization.
  // Replaces the old global BigInt.prototype.toJSON = Number(this) hack that
  // silently truncated IDs > Number.MAX_SAFE_INTEGER. The preSerialization
  // hook recursively converts BigInt to decimal string, preserving full
  // precision for any ID size.
  registerBigIntSerializer(app);

  // Phase 1+2 runtime-security: /health (liveness) and /ready (readiness).
  // /health only reports process liveness; /ready checks PG + Redis.
  registerReadinessRoutes(app);

  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
    : false;

  await app.register(cors, {
    origin: corsOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
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

  await app.register(jwt, {
    secret: jwtSecret,
    sign: { algorithm: "HS256", expiresIn: process.env.JWT_EXPIRES_IN || "2h" },
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
  });

  function isFigureInteractionPath(p: string) {
    return /^\/api\/v1\/figures\/[^/]+\/(social|favorite|like|comments)(?:\?|\/|$)/.test(p);
  }

  app.addHook("onRequest", async (req, reply) => {
    const urlPath = req.url;
    const isAdminPath = urlPath.startsWith("/api/v1/admin");
    const isAuthPath = urlPath.startsWith("/api/v1/auth");
    const isWriteMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    const isFigureWritePath = urlPath.startsWith("/api/v1/figures") && isWriteMethod && !isFigureInteractionPath(urlPath);
    const isEntityWritePath =
      (urlPath.startsWith("/api/v1/manufacturers") ||
        urlPath.startsWith("/api/v1/series") ||
        urlPath.startsWith("/api/v1/sculptors") ||
        urlPath.startsWith("/api/v1/categories") ||
        urlPath.startsWith("/api/v1/characters")) &&
      isWriteMethod;
    if (isAdminPath || isAuthPath) {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    }

    // Phase 1+2 runtime-security: admin guard always re-queries the DB to
    // confirm the user's CURRENT role is admin AND isActive=true. The JWT
    // role claim is NOT trusted — a demoted or deactivated admin's existing
    // token must stop working immediately.
    if (isAdminPath || isFigureWritePath || isEntityWritePath) {
      const ok = await verifyUserFromDb(app, req, reply, ROLE_ADMIN);
      if (!ok) return; // verifyUserFromDb already sent the 401/403 response
    }
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
      const signingSecret = process.env.REVIEW_CACHE_SIGNING_SECRET;
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
      // Phase 1+2 runtime-security: use async fs.promises.readFile instead
      // of fs.readFileSync to avoid blocking the event loop on cached image
      // reads (high-frequency request path).
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

  app.register(adminRoutes, { prefix: "/api/v1/admin" });
  app.register(authRoutes, { prefix: "/api/v1/auth" });
  app.register(communityRoutes, { prefix: "/api/v1" });

  // Phase 1+2 runtime-security: sanitized error handler.
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
      // In production, suppress raw error.message for 4xx — it may contain
      // internal details. Keep it in dev for debugging.
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
  // On SIGTERM/SIGINT: stop accepting new connections, drain in-flight
  // requests, disconnect Prisma, quit Redis. Orchestrators (Docker/k8s)
  // send SIGTERM; Ctrl+C sends SIGINT.
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return; // idempotent
    shuttingDown = true;
    app.log.info({ signal }, "Graceful shutdown started");
    try {
      await app.close(); // closes HTTP server + runs onClose hooks
    } catch (err) {
      app.log.error({ err }, "Error during Fastify close");
    }
    try {
      await prisma.$disconnect();
      app.log.info("Prisma disconnected");
    } catch (err) {
      app.log.error({ err }, "Error during Prisma disconnect");
    }
    try {
      redis.disconnect();
      app.log.info("Redis disconnected");
    } catch (err) {
      app.log.error({ err }, "Error during Redis disconnect");
    }
    app.log.info("Graceful shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ port: 3000, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
