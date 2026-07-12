import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PostgresReviewStore } from "../../modules/reviews/postgres-review-store.js";

const DATABASE_URL = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
const RUN_INTEGRATION = !!DATABASE_URL && process.env.SKIP_DB_TESTS !== "true";

const describeDb = RUN_INTEGRATION ? describe : describe.skip;

describeDb("PostgresReviewStore — real PostgreSQL", () => {
  let prisma: PrismaClient;
  let store: PostgresReviewStore;
  const testId = `integration-test-${Date.now()}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    store = new PostgresReviewStore(prisma);
  });

  afterAll(async () => {
    await prisma.reviewItem.deleteMany({ where: { publicId: { startsWith: "integration-test" } } });
    await prisma.$disconnect();
  });

  it("creates a review item with generated publicId", async () => {
    const item = await store.create({ title: `Integration test ${testId}`, type: "general" });
    expect(item.id).toBeTruthy();
    expect(item.status).toBe("pending");
    expect(item.title).toContain("Integration test");
  });

  it("retrieves item by publicId", async () => {
    const created = await store.create({ title: `Get test ${testId}`, type: "general" });
    const retrieved = await store.getById(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
  });

  it("transitions status with version lock", async () => {
    const item = await store.create({ title: `Transition test ${testId}`, type: "general" });
    const result = await store.transition({
      id: item.id,
      action: "approve",
      targetStatus: "approved",
    });
    expect(result.success).toBe(true);
    const updated = await store.getById(item.id);
    expect(updated!.status).toBe("approved");
  });

  it("rejects transition on version conflict", async () => {
    const item = await store.create({ title: `Conflict test ${testId}`, type: "general" });
    // First transition succeeds
    await store.transition({ id: item.id, action: "approve", targetStatus: "approved" });
    // Second transition with outdated version expectation
    const result = await store.transition({
      id: item.id,
      action: "reject",
      targetStatus: "rejected",
      expectedStatus: "pending",
    });
    expect(result.success).toBe(false);
    expect(["CONFLICT", "STATUS_CONFLICT"]).toContain(result.code);
  });

  it("rejects duplicate publicId at database level", async () => {
    await store.create({ title: `Duplicate test ${testId}`, type: "general" });
    await expect(
      store.create({ title: `Duplicate test ${testId}`, type: "general" })
    ).rejects.toThrow();
  });

  it("lists items with pagination", async () => {
    const result = await store.list({ limit: 10, offset: 0 });
    expect(result.items).toBeDefined();
    expect(result.meta.total).toBeGreaterThanOrEqual(0);
  });

  it("filters by status", async () => {
    const result = await store.list({ status: "pending", limit: 50, offset: 0 });
    for (const item of result.items) {
      expect(item.status).toBe("pending");
    }
  });
});
