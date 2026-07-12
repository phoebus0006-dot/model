import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = {
  reviewItem: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  reviewEvent: {
    create: vi.fn(),
  },
  $transaction: vi.fn(),
};

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(() => mockPrisma),
  Prisma: { PrismaClientKnownRequestError: class extends Error { code: string = "P2025"; } },
}));

const { PostgresReviewStore } = await import("../modules/reviews/postgres-review-store.js");

function makeStore() {
  return new PostgresReviewStore(mockPrisma as any);
}

describe("PostgresReviewStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getById", () => {
    it("returns null when item not found", async () => {
      mockPrisma.reviewItem.findUnique.mockResolvedValue(null);
      const store = makeStore();
      const result = await store.getById("nonexistent");
      expect(result).toBeNull();
      expect(mockPrisma.reviewItem.findUnique).toHaveBeenCalledWith({ where: { publicId: "nonexistent" } });
    });

    it("returns DTO when item found", async () => {
      mockPrisma.reviewItem.findUnique.mockResolvedValue({
        publicId: "test-1", type: "general", title: "Test item", source: null,
        sourceId: null, status: "pending", priority: 1, confidence: null,
        figureId: null, figureSlug: null, riskType: null, riskReason: null,
        suggestedAction: null, evidenceFingerprint: null, reviewer: null,
        decisionReason: null, decisionAt: null, payload: null, notes: null,
        createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
        version: 0,
      });
      const store = makeStore();
      const result = await store.getById("test-1");
      expect(result).not.toBeNull();
      expect(result.id).toBe("test-1");
      expect(result.status).toBe("pending");
    });
  });

  describe("create", () => {
    it("creates a review item with generated ID", async () => {
      const now = new Date();
      mockPrisma.reviewItem.create.mockResolvedValue({
        publicId: "12345-abc", type: "general", title: "New item", source: null,
        sourceId: null, status: "pending", priority: 1, confidence: null,
        figureId: null, figureSlug: null, riskType: null, riskReason: null,
        suggestedAction: null, evidenceFingerprint: null, reviewer: null,
        decisionReason: null, decisionAt: null, payload: null, notes: null,
        createdAt: now, updatedAt: now, version: 0,
      });
      mockPrisma.reviewEvent.create.mockResolvedValue({ id: 1n });
      const store = makeStore();
      const result = await store.create({ title: "New item", type: "general" });
      expect(result).not.toBeNull();
      expect(result.title).toBe("New item");
      expect(mockPrisma.reviewItem.create).toHaveBeenCalled();
      expect(mockPrisma.reviewEvent.create).toHaveBeenCalled();
    });
  });

  describe("transition with optimistic concurrency", () => {
    it("succeeds when version matches", async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          reviewItem: {
            findUnique: vi.fn().mockResolvedValue({
              id: 1n, publicId: "test-1", status: "pending", version: 0,
            }),
            update: vi.fn().mockResolvedValue({
              id: 1n, publicId: "test-1", status: "approved", version: 1,
            }),
          },
          reviewEvent: {
            create: vi.fn().mockResolvedValue({ id: 1n }),
          },
        };
        return fn(tx);
      });
      const store = makeStore();
      const result = await store.transition({ id: "test-1", action: "approve", targetStatus: "approved" });
      expect(result.success).toBe(true);
    });

    it("returns NOT_FOUND when item missing", async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          reviewItem: {
            findUnique: vi.fn().mockResolvedValue(null),
          },
        };
        return fn(tx);
      });
      const store = makeStore();
      const result = await store.transition({ id: "missing", action: "approve", targetStatus: "approved" });
      expect(result.success).toBe(false);
      expect(result.code).toBe("NOT_FOUND");
    });

    it("returns CONFLICT on version mismatch", async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          reviewItem: {
            findUnique: vi.fn().mockResolvedValue({ id: 1n, publicId: "test-1", status: "pending", version: 0 }),
            update: vi.fn().mockResolvedValue(null),
          },
        };
        return fn(tx);
      });
      const store = makeStore();
      const result = await store.transition({ id: "test-1", action: "approve", targetStatus: "approved" });
      expect(result.success).toBe(false);
      expect(result.code).toBe("CONFLICT");
    });

    it("succeeds even without expectedStatus (allows any status)", async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          reviewItem: {
            findUnique: vi.fn().mockResolvedValue({ id: 1n, publicId: "test-1", status: "approved", version: 0 }),
            update: vi.fn().mockResolvedValue({ id: 1n, publicId: "test-1", status: "rejected", version: 1 }),
          },
          reviewEvent: { create: vi.fn().mockResolvedValue({ id: 1n }) },
        };
        return fn(tx);
      });
      const store = makeStore();
      const result = await store.transition({ id: "test-1", action: "reject", targetStatus: "rejected" });
      expect(result.success).toBe(true);
    });

    it("returns STATUS_CONFLICT when current status does not match expected", async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          reviewItem: {
            findUnique: vi.fn().mockResolvedValue({ id: 1n, publicId: "test-1", status: "approved", version: 1 }),
          },
        };
        return fn(tx);
      });
      const store = makeStore();
      const result = await store.transition({ id: "test-1", action: "reject", targetStatus: "rejected", expectedStatus: "pending" });
      expect(result.success).toBe(false);
      expect(result.code).toBe("STATUS_CONFLICT");
    });
  });

  describe("list", () => {
    it("returns paginated results", async () => {
      mockPrisma.reviewItem.findMany.mockResolvedValue([]);
      mockPrisma.reviewItem.count.mockResolvedValue(0);
      const store = makeStore();
      const result = await store.list({ limit: 50, offset: 0 });
      expect(result.items).toEqual([]);
      expect(result.meta.total).toBe(0);
    });

    it("filters by status when provided", async () => {
      mockPrisma.reviewItem.findMany.mockResolvedValue([]);
      mockPrisma.reviewItem.count.mockResolvedValue(0);
      const store = makeStore();
      await store.list({ status: "pending", limit: 20, offset: 0 });
      const callArgs = mockPrisma.reviewItem.findMany.mock.calls[0][0];
      expect(callArgs.where.status).toBe("pending");
    });
  });
});
