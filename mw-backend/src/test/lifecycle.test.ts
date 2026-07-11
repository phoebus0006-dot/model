import { describe, it, expect, vi, afterEach } from "vitest";

describe("Prisma lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PrismaClient constructor can be called without throwing", async () => {
    // This is a minimal connectivity test — does not connect to real DB
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({
      datasources: { db: { url: "postgresql://127.0.0.1:1/nonexistent" } },
    });
    expect(prisma).toBeDefined();
    expect(typeof prisma.$disconnect).toBe("function");
    await prisma.$disconnect();
  });

  it("prisma.$disconnect can be called multiple times without error", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({
      datasources: { db: { url: "postgresql://127.0.0.1:1/nonexistent" } },
    });
    await prisma.$disconnect();
    await expect(prisma.$disconnect()).resolves.toBeUndefined();
  });
});

describe("Redis lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ioredis constructor creates a client", async () => {
    const Redis = (await import("ioredis")).default;
    const redis = new Redis("redis://127.0.0.1:1", {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // No retry
      lazyConnect: true,
    });
    expect(redis).toBeDefined();
    expect(typeof redis.quit).toBe("function");
    // quit resolves even if not connected
    await redis.quit();
  });

  it("redis.quit can be called multiple times", async () => {
    const Redis = (await import("ioredis")).default;
    const redis = new Redis("redis://127.0.0.1:1", {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    const first = await redis.quit();
    // ioredis quit returns "OK" on first call
    expect(first).toBe("OK");
    // Second quit should not throw (may return string or undefined)
    const second = await redis.quit();
    expect(typeof second).toBe("string");
  });
});
