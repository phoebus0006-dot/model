// Wave 2 Runtime: graceful shutdown manager.
//
// Contract: docs/implementation/WAVE2_AGENT_CONTRACTS.md (Agent Runtime task
// #10) and the Phase 1+2 readiness contract.
//
// Guarantees:
//   - Idempotent: calling shutdown() twice is a no-op (the second call
//     resolves immediately without re-running close hooks).
//   - Timeout-bounded: if app.close() / prisma.$disconnect() / redis.quit()
//     hang, a hard timeout (default 30s) forces process.exit so the
//     orchestrator can restart the instance.
//   - Ordered: HTTP server closes first (stop accepting connections), then
//     Prisma disconnects, then Redis quits. Each step is isolated — a
//     failure in one does not skip the others.
//   - Cleanup on startup failure: if listen() throws, shutdown() is called
//     so any partially-opened resources (Prisma/Redis clients) are released.
//
// Signals handled: SIGTERM (orchestrator), SIGINT (Ctrl+C).

import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";

export interface ShutdownManager {
  /** Begin graceful shutdown. Idempotent. Resolves once cleanup is done. */
  shutdown(signal: string): Promise<void>;
  /** True once shutdown has started. */
  isShuttingDown(): boolean;
}

interface ShutdownDeps {
  app: FastifyInstance;
  prisma: PrismaClient;
  redis: Redis;
  /** Hard timeout in ms before forcing exit. Default 30000. */
  timeoutMs?: number;
  /** Called on completion (defaults to process.exit). Exposed for tests. */
  onExit?: (code: number) => void;
}

export function createShutdownManager(deps: ShutdownDeps): ShutdownManager {
  const { app, prisma, redis } = deps;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const onExit = deps.onExit ?? ((code: number) => process.exit(code));

  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  async function doShutdown(signal: string): Promise<void> {
    app.log.info({ signal }, "Graceful shutdown started");

    // 1. Close the HTTP server + run Fastify onClose hooks (stops accepting
    //    new connections and drains in-flight requests).
    try {
      await app.close();
      app.log.info("Fastify closed");
    } catch (err) {
      app.log.error({ err }, "Error during Fastify close");
    }

    // 2. Disconnect Prisma. Isolated so a Redis failure doesn't skip this.
    try {
      await prisma.$disconnect();
      app.log.info("Prisma disconnected");
    } catch (err) {
      app.log.error({ err }, "Error during Prisma disconnect");
    }

    // 3. Quit Redis. ioredis.disconnect() is non-blocking and always safe.
    try {
      redis.disconnect();
      app.log.info("Redis disconnected");
    } catch (err) {
      app.log.error({ err }, "Error during Redis disconnect");
    }

    app.log.info("Graceful shutdown complete");
  }

  async function shutdown(signal: string): Promise<void> {
    // Idempotent: the second caller gets the same promise and does not
    // trigger another close cycle.
    if (shuttingDown) return shutdownPromise ?? Promise.resolve();
    shuttingDown = true;

    shutdownPromise = (async () => {
      // Race the shutdown against a hard timeout. If cleanup hangs, force
      // exit so the orchestrator can restart the instance.
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          app.log.error(
            { signal, timeoutMs },
            "Shutdown timed out — forcing exit",
          );
          resolve();
        }, timeoutMs);
      });

      try {
        await Promise.race([doShutdown(signal), timeout]);
      } catch (err) {
        app.log.error({ err }, "Unexpected error during shutdown");
      } finally {
        if (timer) clearTimeout(timer);
      }
      onExit(0);
    })();

    return shutdownPromise;
  }

  return {
    shutdown,
    isShuttingDown: () => shuttingDown,
  };
}
