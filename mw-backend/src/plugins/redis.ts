import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import Redis from "ioredis";

export const redisPlugin = fp(async (app: FastifyInstance) => {
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379", {
    maxRetriesPerRequest: 3,
  });

  redis.on("error", (err: Error) => app.log.error({ err }, "Redis error:"));
  redis.on("connect", () => app.log.info("Redis connected"));

  app.decorate("redis", redis);

  app.addHook("onClose", async () => {
    await redis.quit();
  });
});

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}
