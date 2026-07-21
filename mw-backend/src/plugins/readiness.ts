// Phase 1+2 runtime-security: /health and /ready endpoints with independent timeouts.

import type { FastifyInstance } from "fastify";

export interface ReadinessCheck {
  postgres: "ok" | "fail";
  redis: "ok" | "fail";
}

export interface ReadinessResult {
  status: "ready" | "not_ready";
  checks: ReadinessCheck;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

async function checkPostgres(prisma: any, timeoutMs = 2000): Promise<"ok" | "fail"> {
  if (!prisma) return "fail";
  try {
    const task = prisma.$queryRaw`SELECT 1`.then(() => "ok" as const).catch(() => "fail" as const);
    return await withTimeout(task, timeoutMs, "fail");
  } catch {
    return "fail";
  }
}

async function checkRedis(redis: any, timeoutMs = 2000): Promise<"ok" | "fail"> {
  if (!redis) return "fail";
  try {
    const task = redis.ping().then((res: string) => (res === "PONG" ? ("ok" as const) : ("fail" as const))).catch(() => "fail" as const);
    return await withTimeout(task, timeoutMs, "fail");
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

  // Readiness — check PG + Redis with independent timeouts
  app.get("/ready", async (_req: any, reply: any) => {
    const prisma = (app as any).prisma;
    const redis = (app as any).redis;

    const [pgStatus, redisStatus] = await Promise.all([
      checkPostgres(prisma, 2000),
      checkRedis(redis, 2000),
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
