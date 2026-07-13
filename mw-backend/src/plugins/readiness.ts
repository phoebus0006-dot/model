// Phase 1+2 runtime-security: /health and /ready endpoints.
//
// Contract: docs/implementation/PHASE12_CONTRACT.md §health-checks
//
// /health — liveness probe. Returns 200 { status: "ok" } as long as the
//   process is alive and the event loop is turning. Does NOT check any
//   external dependencies (PG/Redis). Used by orchestrators to decide
//   whether to restart the container.
//
// /ready — readiness probe. Actually checks PostgreSQL (SELECT 1) and
//   Redis (PING). Returns 200 if both are reachable, 503 otherwise. Used
//   by orchestrators to decide whether to route traffic to this instance.
//
// Run tests: npx tsx --test src/plugins/readiness.test.ts

import type { FastifyInstance } from "fastify";

export interface ReadinessCheck {
  postgres: "ok" | "fail";
  redis: "ok" | "fail";
}

export interface ReadinessResult {
  status: "ready" | "not_ready";
  checks: ReadinessCheck;
}

async function checkPostgres(prisma: any): Promise<"ok" | "fail"> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "fail";
  }
}

async function checkRedis(redis: any): Promise<"ok" | "fail"> {
  try {
    const res = await redis.ping();
    return res === "PONG" ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

/**
 * Register /health and /ready routes on a Fastify instance. Both routes
 * are registered at the root level (no prefix).
 */
export function registerReadinessRoutes(app: FastifyInstance): void {
  // Liveness — always 200 if the process is alive
  app.get("/health", async () => {
    return { status: "ok" };
  });

  // Readiness — check PG + Redis
  app.get("/ready", async (_req: any, reply: any) => {
    const prisma = (app as any).prisma;
    const redis = (app as any).redis;

    const [pgStatus, redisStatus] = await Promise.all([
      prisma ? checkPostgres(prisma) : ("fail" as const),
      redis ? checkRedis(redis) : ("fail" as const),
    ]);

    const checks: ReadinessCheck = { postgres: pgStatus, redis: redisStatus };
    const ready = pgStatus === "ok" && redisStatus === "ok";

    reply.status(ready ? 200 : 503);
    return {
      status: ready ? "ready" : "not_ready",
      checks,
    } as ReadinessResult;
  });
}
