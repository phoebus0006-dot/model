import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

const DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
const RUN_INTEGRATION = !!DATABASE_URL && process.env.SKIP_DB_TESTS !== "true";

const describeDb = RUN_INTEGRATION ? describe : describe.skip;

describeDb("ReviewApplyAttempt — real PostgreSQL", () => {
  let prisma: PrismaClient;
  const testPrefix = `attempt-int-${Date.now()}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  });

  afterAll(async () => {
    await prisma.reviewItem.deleteMany({ where: { publicId: { startsWith: testPrefix } } });
    await prisma.$disconnect();
  });

  async function createTestItem(): Promise<string> {
    const item = await prisma.reviewItem.create({
      data: {
        publicId: `${testPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: "Integration test review item",
        type: "general",
        status: "pending",
      },
    });
    return item.publicId;
  }

  it("creates a PENDING attempt", async () => {
    const reviewId = await createTestItem();
    const reviewItem = await prisma.reviewItem.findUnique({ where: { publicId: reviewId } });
    const attempt = await prisma.reviewApplyAttempt.create({
      data: {
        publicId: `${testPrefix}-attempt-1`,
        reviewItemId: reviewItem!.id,
        status: "PENDING",
        attemptNumber: 1,
      },
    });
    expect(attempt.status).toBe("PENDING");
    expect(attempt.attemptNumber).toBe(1);
  });

  it("transitions PENDING → RUNNING → SUCCEEDED", async () => {
    const reviewId = await createTestItem();
    const reviewItem = await prisma.reviewItem.findUnique({ where: { publicId: reviewId } });

    const attempt = await prisma.reviewApplyAttempt.create({
      data: {
        publicId: `${testPrefix}-transition`,
        reviewItemId: reviewItem!.id,
        status: "PENDING",
        attemptNumber: 1,
      },
    });

    const running = await prisma.reviewApplyAttempt.update({
      where: { id: attempt.id },
      data: { status: "RUNNING", currentStep: "figure_create", startedAt: new Date() },
    });
    expect(running.status).toBe("RUNNING");

    const succeeded = await prisma.reviewApplyAttempt.update({
      where: { id: attempt.id },
      data: { status: "SUCCEEDED", currentStep: "done", completedAt: new Date() },
    });
    expect(succeeded.status).toBe("SUCCEEDED");
  });

  it("enforces idempotencyKey uniqueness", async () => {
    const reviewId = await createTestItem();
    const reviewItem = await prisma.reviewItem.findUnique({ where: { publicId: reviewId } });

    await prisma.reviewApplyAttempt.create({
      data: {
        publicId: `${testPrefix}-idem-1`,
        reviewItemId: reviewItem!.id,
        idempotencyKey: "test-idem-key-1",
        status: "PENDING",
        attemptNumber: 1,
      },
    });

    await expect(
      prisma.reviewApplyAttempt.create({
        data: {
          publicId: `${testPrefix}-idem-2`,
          reviewItemId: reviewItem!.id,
          idempotencyKey: "test-idem-key-1",
          status: "PENDING",
          attemptNumber: 2,
        },
      })
    ).rejects.toThrow();
  });

  it("enforces (reviewItemId, attemptNumber) uniqueness", async () => {
    const reviewId = await createTestItem();
    const reviewItem = await prisma.reviewItem.findUnique({ where: { publicId: reviewId } });

    await prisma.reviewApplyAttempt.create({
      data: {
        publicId: `${testPrefix}-uniq-1`,
        reviewItemId: reviewItem!.id,
        status: "PENDING",
        attemptNumber: 1,
      },
    });

    await expect(
      prisma.reviewApplyAttempt.create({
        data: {
          publicId: `${testPrefix}-uniq-2`,
          reviewItemId: reviewItem!.id,
          status: "PENDING",
          attemptNumber: 1,  // Same reviewItemId + attemptNumber
        },
      })
    ).rejects.toThrow();
  });

  it("rejects invalid status transitions", async () => {
    const reviewId = await createTestItem();
    const reviewItem = await prisma.reviewItem.findUnique({ where: { publicId: reviewId } });

    const attempt = await prisma.reviewApplyAttempt.create({
      data: {
        publicId: `${testPrefix}-invalid`,
        reviewItemId: reviewItem!.id,
        status: "PENDING",
        attemptNumber: 1,
      },
    });

    // Cannot skip from PENDING directly to SUCCEEDED
    await expect(
      prisma.reviewApplyAttempt.update({
        where: { id: attempt.id },
        data: { status: "SUCCEEDED" },
      })
    ).rejects.toThrow();
  });

  it("stores BigInt targetFigureId accurately", async () => {
    const reviewId = await createTestItem();
    const reviewItem = await prisma.reviewItem.findUnique({ where: { publicId: reviewId } });
    const largeId = BigInt("9223372036854775807");

    const attempt = await prisma.reviewApplyAttempt.create({
      data: {
        publicId: `${testPrefix}-bigint`,
        reviewItemId: reviewItem!.id,
        status: "PENDING",
        attemptNumber: 1,
        targetFigureId: largeId,
      },
    });

    expect(attempt.targetFigureId).toBe(largeId);
    expect(String(attempt.targetFigureId)).toBe("9223372036854775807");
  });
});
