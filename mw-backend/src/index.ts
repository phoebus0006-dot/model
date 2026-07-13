import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fs from "fs";
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";
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

Object.defineProperty(BigInt.prototype, "toJSON", { value: function () { return Number(this); }, writable: true, configurable: true });

async function main() {
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 20 * 1024 * 1024) });
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  const jwtSecret = process.env.JWT_SECRET || "dev-secret-change-in-production";
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction && (!process.env.JWT_SECRET || jwtSecret === "dev-secret-change-in-production" || jwtSecret.length < 32)) {
    throw new Error("JWT_SECRET must be set to a strong secret in production");
  }

  app.decorate("prisma", prisma);
  app.decorate("redis", redis);

  // Phase 1+2 runtime-security: install FLUSHDB/FLUSHALL guard on the Redis
  // client. Contract §14: "FLUSHDB / FLUSHALL are forbidden everywhere; the
  // codebase MUST NOT call them, and a runtime guard MUST reject any attempt."
  // This blocks both direct method calls (redis.flushdb()) and raw
  // sendCommand({ name: "FLUSHDB" }) calls. Non-removable once installed.
  installRedisFlushGuard(redis);

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

  function isFigureInteractionPath(path: string) {
    return /^\/api\/v1\/figures\/[^/]+\/(social|favorite|like|comments)(?:\?|\/|$)/.test(path);
  }

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url;
    const isAdminPath = path.startsWith("/api/v1/admin");
    const isAuthPath = path.startsWith("/api/v1/auth");
    const isWriteMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    const isFigureWritePath = path.startsWith("/api/v1/figures") && isWriteMethod && !isFigureInteractionPath(path);
    const isEntityWritePath =
      (path.startsWith("/api/v1/manufacturers") ||
        path.startsWith("/api/v1/series") ||
        path.startsWith("/api/v1/sculptors") ||
        path.startsWith("/api/v1/categories") ||
        path.startsWith("/api/v1/characters")) &&
      isWriteMethod;
    if (isAdminPath || isAuthPath) {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    }

    if (isAdminPath || isFigureWritePath || isEntityWritePath) {
      try {
        const auth = req.headers.authorization;
        if (!auth?.startsWith("Bearer ") || auth.length <= 7) throw new Error();
        const payload = app.jwt.verify<{ userId: string | number; role: string }>(auth.slice(7));
        const user = await prisma.user.findUnique({
          where: { id: BigInt(payload.userId) },
          select: { id: true, role: true, isActive: true },
        });
        if (!user?.isActive || user.role !== "admin") throw new Error();
        (req as any).user = { userId: user.id.toString(), role: user.role };
      } catch {
        return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
      }
    }
  });

  app.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

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
        return reply.status(500).send({ success: false, error: { code: "SIGNING_NOT_CONFIGURED", message: "REVIEW_CACHE_SIGNING_SECRET is not set" } });
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
      if (!fs.existsSync(filePath)) {
        return reply.status(404).send({ success: false, error: { code: "NOT_FOUND" } });
      }
      // Determine Content-Type from actual image format using sharp
      const fileBuf = fs.readFileSync(filePath);
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

  app.setErrorHandler((error: any, req: any, reply: any) => {
    if (error?.name === "ZodError" || Array.isArray(error?.issues)) {
      return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", details: error.issues || error.errors } });
    }
    if (error.validation) return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", details: error.validation } });
    if (error.statusCode === 429) return reply.status(429).send({ success: false, error: { code: "RATE_LIMITED" } });
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        success: false,
        error: {
          code: error.code || "BAD_REQUEST",
          message: error.message,
        },
      });
    }
    app.log.error(error);
    reply.status(500).send({ success: false, error: { code: "INTERNAL_ERROR" } });
  });

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
