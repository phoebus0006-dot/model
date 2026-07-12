import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyFigureImport,
  applyJanMatch,
  applyRewrite,
  applyImage,
  applyImageReview,
  applyItemStatus,
  type ApplyActor,
} from "../modules/reviews/apply-business.js";
import { ApplyDependencyError, ApplyValidationError } from "../modules/reviews/apply-errors.js";

// Mock external module dependencies
vi.mock("../modules/images/image-service.js");
vi.mock("../shared/cache/scan-keys.js");

import { processAndStoreImage, upsertFigureImageRecord } from "../modules/images/image-service.js";
import { scanKeys } from "../shared/cache/scan-keys.js";

function mockRedis(): any {
  const store: Record<string, string> = {};
  return {
    set: vi.fn(async (key: string, value: string, ...args: string[]) => {
      if (args.includes("NX") && store[key]) return null;
      store[key] = value;
      return "OK";
    }),
    get: vi.fn(async (key: string) => store[key] || null),
    del: vi.fn(async (...keys: string[]) => {
      let c = 0;
      for (const k of keys) { if (store[k]) { delete store[k]; c++; } }
      return c;
    }),
    eval: vi.fn(),
    _store: store,
  };
}

function mockPrisma() {
  return {
    figure: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    revision: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    figureImage: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  };
}

function makeContext(overrides?: Record<string, any>): any {
  return {
    redis: mockRedis(),
    prisma: mockPrisma(),
    verifyLock: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const defaultActor: ApplyActor = { userId: "user-1", displayName: "Test User" };
const defaultItem = { id: "item-1", type: "figure_import", figureSlug: "test-fig", payload: {} };

beforeEach(() => {
  vi.mocked(processAndStoreImage).mockReset().mockResolvedValue([]);
  vi.mocked(upsertFigureImageRecord).mockReset();
  vi.mocked(scanKeys).mockReset().mockResolvedValue({ matched: 0, deleted: 0, failed: 0, truncated: false });
});

// ---------------------------------------------------------------------------
// figure_import apply
// ---------------------------------------------------------------------------
describe("figure_import apply", () => {
  it("creates a new figure successfully", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(42), slug: "new-fig", janCode: null });

    const result = await applyFigureImport(
      ctx, defaultItem, "item-1", defaultActor,
      { slug: "new-fig", name: "New Figure" }, "figure_import",
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("figure_created");
    expect(result.figure).toEqual({ id: "42", slug: "new-fig" });
    expect(ctx.prisma.figure.create).toHaveBeenCalledTimes(1);
  });

  it("updates an existing figure when slug already exists", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "existing-fig", janCode: null });
    ctx.prisma.figure.update.mockResolvedValue({ id: BigInt(1), slug: "existing-fig" });

    const result = await applyFigureImport(
      ctx, defaultItem, "item-1", defaultActor,
      { slug: "existing-fig", name: "Updated Name" }, "figure_import",
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("figure_updated");
    expect(result.figure).toEqual({ id: "1", slug: "existing-fig" });
  });

  it("throws figure identity conflict when slug and janCode point to different figures", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst
      .mockResolvedValueOnce({ id: BigInt(1), slug: "slug-fig", janCode: "111" })
      .mockResolvedValueOnce({ id: BigInt(2), slug: "jan-fig", janCode: "222" });

    await expect(
      applyFigureImport(
        ctx, defaultItem, "item-1", defaultActor,
        { slug: "slug-fig", name: "Conflict", janCode: "222" }, "figure_import",
      ),
    ).rejects.toThrow(ApplyDependencyError);
  });

  it("throws validation error when slug is missing", async () => {
    const ctx = makeContext();
    await expect(
      applyFigureImport(
        ctx, defaultItem, "item-1", defaultActor,
        { name: "No Slug" } as any, "figure_import",
      ),
    ).rejects.toThrow(ApplyValidationError);
  });

  it("throws validation error when name is missing", async () => {
    const ctx = makeContext();
    await expect(
      applyFigureImport(
        ctx, defaultItem, "item-1", defaultActor,
        { slug: "no-name" } as any, "figure_import",
      ),
    ).rejects.toThrow(ApplyValidationError);
  });
});

// ---------------------------------------------------------------------------
// jan_match apply
// ---------------------------------------------------------------------------
describe("jan_match apply", () => {
  it("matches source figure to target JAN figure", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst
      .mockResolvedValueOnce({ id: BigInt(2), slug: "target-fig" })
      .mockResolvedValueOnce({ id: BigInt(1), slug: "source-fig", janCode: null });
    ctx.prisma.figure.update.mockResolvedValue({ id: BigInt(1) });

    const result = await applyJanMatch(
      ctx, { ...defaultItem, type: "jan_match" }, "item-1", defaultActor,
      { janCode: "456" }, "jan_match",
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("jan_matched");
    expect(ctx.prisma.figure.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(1) },
        data: expect.objectContaining({ janCode: "456", parentId: BigInt(2) }),
      }),
    );
  });

  it("returns jan_already_matched when source and target are the same figure", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst
      .mockResolvedValueOnce({ id: BigInt(1), slug: "same-fig" })
      .mockResolvedValueOnce({ id: BigInt(1), slug: "same-fig", janCode: "456" });

    const result = await applyJanMatch(
      ctx, { ...defaultItem, type: "jan_match", figureSlug: "same-fig" }, "item-1", defaultActor,
      { janCode: "456" }, "jan_match",
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("jan_already_matched");
    expect(ctx.prisma.figure.update).not.toHaveBeenCalled();
  });

  it("throws FIGURE_NOT_FOUND when target JAN figure does not exist", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);

    await expect(
      applyJanMatch(ctx, defaultItem, "item-1", defaultActor, { janCode: "missing" }, "jan_match"),
    ).rejects.toThrow(ApplyDependencyError);
  });

  it("throws validation error when janCode is empty", async () => {
    const ctx = makeContext();
    await expect(
      applyJanMatch(ctx, defaultItem, "item-1", defaultActor, { janCode: "" }, "jan_match"),
    ).rejects.toThrow(ApplyValidationError);
  });

  it("throws FIGURE_NOT_FOUND when source figure slug does not exist", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst
      .mockResolvedValueOnce({ id: BigInt(1), slug: "target" })
      .mockResolvedValueOnce(null);

    await expect(
      applyJanMatch(ctx, { ...defaultItem, figureSlug: "missing-source" }, "item-1", defaultActor, { janCode: "456" }, "jan_match"),
    ).rejects.toThrow(ApplyDependencyError);
  });
});

// ---------------------------------------------------------------------------
// rewrite apply
// ---------------------------------------------------------------------------
describe("rewrite apply", () => {
  it("creates a new revision with version 1 when none exist", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "rewrite-fig" });
    ctx.prisma.revision.findFirst.mockResolvedValue(null);
    ctx.prisma.revision.create.mockResolvedValue({ id: BigInt(100), versionNumber: 1 });
    ctx.prisma.figure.update.mockResolvedValue({ id: BigInt(1) });

    const result = await applyRewrite(
      ctx, { ...defaultItem, type: "rewrite", figureSlug: "rewrite-fig" }, "item-1", defaultActor,
      { contentMd: "# New Content", summaryMd: "Sum", editSummary: "Test" }, "rewrite",
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("rewrite_applied");
    expect(result.revision).toEqual({ id: "100", versionNumber: 1 });
  });

  it("increments version number from existing max version", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "ver-fig" });
    ctx.prisma.revision.findFirst.mockResolvedValue({ versionNumber: 5 });
    ctx.prisma.revision.create.mockResolvedValue({ id: BigInt(101), versionNumber: 6 });
    ctx.prisma.figure.update.mockResolvedValue({ id: BigInt(1) });

    const result = await applyRewrite(
      ctx, { ...defaultItem, type: "rewrite", figureSlug: "ver-fig" }, "item-1", defaultActor,
      { contentMd: "# v6" }, "rewrite",
    );

    expect(result.revision!.versionNumber).toBe(6);
    expect(ctx.prisma.revision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ versionNumber: 6 }) }),
    );
  });

  it("throws when figure is not found", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);

    await expect(
      applyRewrite(ctx, { ...defaultItem, type: "rewrite", figureSlug: "missing" }, "item-1", defaultActor, { contentMd: "# x" }, "rewrite"),
    ).rejects.toThrow(ApplyDependencyError);
  });

  it("throws when revision creation fails", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "fail-fig" });
    ctx.prisma.revision.findFirst.mockResolvedValue(null);
    ctx.prisma.revision.create.mockRejectedValue(new Error("DB error"));

    await expect(
      applyRewrite(ctx, { ...defaultItem, type: "rewrite", figureSlug: "fail-fig" }, "item-1", defaultActor, { contentMd: "# x" }, "rewrite"),
    ).rejects.toThrow("DB error");
  });

  it("applies rewrite with minimal fields (empty content)", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "min-fig" });
    ctx.prisma.revision.findFirst.mockResolvedValue(null);
    ctx.prisma.revision.create.mockResolvedValue({ id: BigInt(1), versionNumber: 1 });
    ctx.prisma.figure.update.mockResolvedValue({ id: BigInt(1) });

    const result = await applyRewrite(
      ctx, { ...defaultItem, type: "rewrite", figureSlug: "min-fig" }, "item-1", defaultActor,
      {}, "rewrite",
    );

    expect(result.success).toBe(true);
    expect(ctx.prisma.revision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contentMd: "" }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// image apply
// ---------------------------------------------------------------------------
describe("image apply", () => {
  const imageRecord = {
    sha256: "abc123", janCode: "j123", size: "raw", format: "jpg",
    width: 800, height: 600, fileSize: 50000, alt: "test", sortOrder: 0,
    source: "http://example.com/img.jpg", isNsfw: false,
  };

  it("imports an image successfully", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "img-fig", janCode: "j123" });
    vi.mocked(processAndStoreImage).mockResolvedValue([imageRecord]);
    vi.mocked(upsertFigureImageRecord).mockResolvedValue({ image: { id: BigInt(99) } } as any);

    const result = await applyImage(
      ctx, { ...defaultItem, type: "image", figureSlug: "img-fig" }, "item-1", defaultActor,
      { source: "http://example.com/img.jpg", alt: "test" }, "image",
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("image_imported");
    expect(result.imageId).toBe("99");
    expect(vi.mocked(processAndStoreImage)).toHaveBeenCalledWith(
      "http://example.com/img.jpg", "j123", ctx.prisma,
      expect.objectContaining({ figureId: BigInt(1) }),
    );
  });

  it("returns image_failed when processAndStoreImage throws", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "fail-img", janCode: "j123" });
    vi.mocked(processAndStoreImage).mockRejectedValue(new Error("Download failed"));

    const result = await applyImage(
      ctx, { ...defaultItem, type: "image", figureSlug: "fail-img" }, "item-1", defaultActor,
      { source: "http://example.com/bad.jpg" }, "image",
    );

    expect(result.success).toBe(false);
    expect(result.action).toBe("image_failed");
    expect(result.failure!.stage).toBe("image_download");
  });

  it("throws when figure is not found", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);

    await expect(
      applyImage(ctx, { ...defaultItem, type: "image", figureSlug: "missing" }, "item-1", defaultActor, { source: "http://example.com/x.jpg" }, "image"),
    ).rejects.toThrow(ApplyDependencyError);
  });

  it("uses default janCode 'no-jancode' when figure has no janCode", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "no-jan" });
    vi.mocked(processAndStoreImage).mockResolvedValue([{ ...imageRecord, janCode: "no-jancode" }]);
    vi.mocked(upsertFigureImageRecord).mockResolvedValue({ image: { id: BigInt(1) } } as any);

    await applyImage(
      ctx, { ...defaultItem, type: "image", figureSlug: "no-jan" }, "item-1", defaultActor,
      { source: "http://example.com/img.jpg" }, "image",
    );

    expect(vi.mocked(processAndStoreImage)).toHaveBeenCalledWith(
      expect.any(String), "no-jancode", expect.anything(), expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// image_review apply
// ---------------------------------------------------------------------------
describe("image_review apply", () => {
  const reviewItem = (extra?: Record<string, any>) => ({
    ...defaultItem, type: "image_review", figureSlug: "review-fig",
    payload: {}, candidateImage: { source: "http://example.com/candidate.jpg" },
    ...extra,
  });

  it("approves a new candidate image", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "review-fig", janCode: "j123" });
    ctx.prisma.figureImage.findFirst.mockResolvedValue(null);
    vi.mocked(processAndStoreImage).mockResolvedValue([
      { sha256: "xyz", janCode: "j123", size: "raw", format: "webp", width: 100, height: 100, fileSize: 200, alt: undefined, sortOrder: 0, source: "http://example.com/candidate.jpg", isNsfw: false },
    ]);
    vi.mocked(upsertFigureImageRecord).mockResolvedValue({ image: { id: BigInt(55) } } as any);

    const result = await applyImageReview(ctx, reviewItem(), "item-1", defaultActor, {}, "approve");

    expect(result.success).toBe(true);
    expect(result.action).toBe("image_approved");
    expect(result.imageId).toBe("55");
  });

  it("returns already_approved when candidate figureImage already exists", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "review-fig", janCode: "j123" });
    ctx.prisma.figureImage.findFirst.mockResolvedValue({ id: BigInt(10), source: "http://example.com/candidate.jpg" });

    const result = await applyImageReview(ctx, reviewItem(), "item-1", defaultActor, {}, "approve");

    expect(result.success).toBe(true);
    expect(result.action).toBe("already_approved");
    expect(ctx.prisma.figureImage.update).toHaveBeenCalled();
  });

  it("throws UNSUPPORTED_ACTION for non-approve action", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "review-fig" });

    await expect(
      applyImageReview(ctx, reviewItem(), "item-1", defaultActor, {}, "reject"),
    ).rejects.toThrow(ApplyValidationError);
  });

  it("throws MISSING_CANDIDATE_IMAGE when candidate is absent", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "no-cand" });

    await expect(
      applyImageReview(ctx, { ...defaultItem, type: "image_review", figureSlug: "no-cand" }, "item-1", defaultActor, {}, "approve"),
    ).rejects.toThrow(ApplyValidationError);
  });

  it("returns failure when image download fails", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "review-fig", janCode: "j123" });
    ctx.prisma.figureImage.findFirst.mockResolvedValue(null);
    vi.mocked(processAndStoreImage).mockRejectedValue(new Error("Timeout"));

    const result = await applyImageReview(ctx, reviewItem(), "item-1", defaultActor, {}, "approve");

    expect(result.success).toBe(false);
    expect(result.action).toBe("image_approve_failed");
  });

  it("throws FIGURE_NOT_FOUND when figure does not exist", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);

    await expect(
      applyImageReview(ctx, reviewItem({ figureSlug: "missing" }), "item-1", defaultActor, {}, "approve"),
    ).rejects.toThrow(ApplyDependencyError);
  });
});

// ---------------------------------------------------------------------------
// success=false propagation
// ---------------------------------------------------------------------------
describe("success=false propagation", () => {
  it("applyFigureImport returns success=false when all images fail", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(1), slug: "all-fail", janCode: "j123" });
    vi.mocked(processAndStoreImage).mockRejectedValue(new Error("Network"));

    const result = await applyFigureImport(
      ctx, defaultItem, "item-1", defaultActor,
      { slug: "all-fail", name: "All Fail", images: [{ source: "http://a.com/1.jpg" }, { source: "http://a.com/2.jpg" }] },
      "figure_import",
    );

    expect(result.success).toBe(false);
    expect(result.failure).toBeDefined();
    expect(result.failure!.stage).toBe("image");
    expect(result.failure!.problems).toContain("All images failed to process");
  });

  it("applyImage returns success=false when image processing fails", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "fail", janCode: "j123" });
    vi.mocked(processAndStoreImage).mockRejectedValue(new Error("Timeout"));

    const result = await applyImage(
      ctx, { ...defaultItem, type: "image", figureSlug: "fail" }, "item-1", defaultActor,
      { source: "http://bad.com/img.jpg" }, "image",
    );

    expect(result.success).toBe(false);
    expect(result.failure!.stage).toBe("image_download");
  });

  it("applyImageReview returns success=false when approve fails", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "fail", janCode: "j123" });
    ctx.prisma.figureImage.findFirst.mockResolvedValue(null);
    vi.mocked(processAndStoreImage).mockRejectedValue(new Error("Timeout"));

    const result = await applyImageReview(
      ctx, { ...defaultItem, type: "image_review", figureSlug: "fail", candidateImage: { source: "http://bad.com/img.jpg" } },
      "item-1", defaultActor, {}, "approve",
    );

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// all images fail
// ---------------------------------------------------------------------------
describe("all images fail", () => {
  it("returns success=false with ALL_IMAGES_FAILED failure when no images processed", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(1), slug: "no-imgs", janCode: "j123" });
    vi.mocked(processAndStoreImage).mockRejectedValue(new Error("fail"));

    const result = await applyFigureImport(
      ctx, defaultItem, "item-1", defaultActor,
      { slug: "no-imgs", name: "No Imgs", images: [{ source: "http://x.com/1.jpg" }] }, "figure_import",
    );

    expect(result.success).toBe(false);
    expect(result.imageImport!.errors.length).toBe(1);
    expect(result.imageImport!.created).toBe(0);
    expect(result.failure!.problems).toContain("All images failed to process");
  });

  it("skips image processing when images array is empty", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(1), slug: "empty-imgs" });

    const result = await applyFigureImport(
      ctx, defaultItem, "item-1", defaultActor,
      { slug: "empty-imgs", name: "Empty", images: [] }, "figure_import",
    );

    expect(result.success).toBe(true);
    expect(result.imageImport!.errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// partial images fail
// ---------------------------------------------------------------------------
describe("partial images fail", () => {
  it("returns success=true with partial errors when some images fail", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(1), slug: "partial", janCode: "j123" });
    vi.mocked(processAndStoreImage)
      .mockResolvedValueOnce([{ sha256: "ok1", janCode: "j123", size: "raw", format: "jpg", width: 100, height: 100, fileSize: 1000, alt: undefined, sortOrder: 0, source: "http://ok.com/1.jpg", isNsfw: false }])
      .mockRejectedValueOnce(new Error("Network error"));

    const result = await applyFigureImport(
      ctx, defaultItem, "item-1", defaultActor,
      { slug: "partial", name: "Partial", images: [{ source: "http://ok.com/1.jpg" }, { source: "http://bad.com/2.jpg" }] },
      "figure_import",
    );

    expect(result.success).toBe(true);
    expect(result.imageImport!.created).toBe(1);
    expect(result.imageImport!.errors.length).toBe(1);
    expect(result.failure).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// lock lost mid-operation
// ---------------------------------------------------------------------------
describe("lock lost mid-operation", () => {
  it("aborts applyFigureImport when verifyLock throws before figure write", async () => {
    const ctx = makeContext();
    ctx.verifyLock = vi.fn().mockRejectedValue(new Error("APPLY_LOCK_LOST"));
    ctx.prisma.figure.findFirst.mockResolvedValue(null);

    await expect(
      applyFigureImport(ctx, defaultItem, "item-1", defaultActor, { slug: "lost-lock", name: "Lost" }, "figure_import"),
    ).rejects.toThrow("APPLY_LOCK_LOST");
  });

  it("aborts applyRewrite when verifyLock throws before revision update", async () => {
    const ctx = makeContext();
    ctx.verifyLock = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("APPLY_LOCK_LOST"));
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "rewrite-lost" });
    ctx.prisma.revision.findFirst.mockResolvedValue(null);
    ctx.prisma.revision.create.mockResolvedValue({ id: BigInt(1), versionNumber: 1 });

    await expect(
      applyRewrite(ctx, { ...defaultItem, type: "rewrite", figureSlug: "rewrite-lost" }, "item-1", defaultActor, { contentMd: "# x" }, "rewrite"),
    ).rejects.toThrow("APPLY_LOCK_LOST");
  });
});

// ---------------------------------------------------------------------------
// duplicate apply idempotency
// ---------------------------------------------------------------------------
describe("duplicate apply idempotency", () => {
  it("same figure_import on same slug produces consistent output", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: BigInt(1), slug: "dup-fig", janCode: null });
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(1), slug: "dup-fig" });
    ctx.prisma.figure.update.mockResolvedValue({ id: BigInt(1), slug: "dup-fig" });

    const dto = { slug: "dup-fig", name: "Dup" };
    const first = await applyFigureImport(ctx, defaultItem, "item-1", defaultActor, dto, "figure_import");
    expect(first.action).toBe("figure_created");

    const second = await applyFigureImport(ctx, defaultItem, "item-1", defaultActor, dto, "figure_import");
    expect(second.action).toBe("figure_updated");
    expect(second.figure).toEqual(first.figure);
    expect(second.success).toBe(true);
  });

  it("jan_match on already matched figure returns jan_already_matched", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst
      .mockResolvedValue({ id: BigInt(1), slug: "target", janCode: "456" });

    const result = await applyJanMatch(
      ctx, { ...defaultItem, type: "jan_match", figureSlug: "target" }, "item-1", defaultActor,
      { janCode: "456" }, "jan_match",
    );

    expect(result.action).toBe("jan_already_matched");
    const result2 = await applyJanMatch(
      ctx, { ...defaultItem, type: "jan_match", figureSlug: "target" }, "item-1", defaultActor,
      { janCode: "456" }, "jan_match",
    );

    expect(result2.action).toBe("jan_already_matched");
    expect(result2.figure).toEqual(result.figure);
  });
});

// ---------------------------------------------------------------------------
// figure identity conflict
// ---------------------------------------------------------------------------
describe("figure identity conflict", () => {
  it("throws FIGURE_IDENTITY_CONFLICT when slug and janCode resolve to different figures", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst
      .mockResolvedValueOnce({ id: BigInt(10), slug: "slug-fig", janCode: "A" })
      .mockResolvedValueOnce({ id: BigInt(20), slug: "jan-fig", janCode: "B" });

    await expect(
      applyFigureImport(ctx, defaultItem, "item-1", defaultActor, { slug: "slug-fig", name: "Test", janCode: "B" }, "figure_import"),
    ).rejects.toThrow(expect.objectContaining({ message: expect.stringContaining("FIGURE_IDENTITY_CONFLICT") }));
  });

  it("does not throw when slug and janCode point to the same figure", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst
      .mockResolvedValueOnce({ id: BigInt(5), slug: "same-fig", janCode: "X" })
      .mockResolvedValueOnce({ id: BigInt(5), slug: "same-fig", janCode: "X" });
    ctx.prisma.figure.update.mockResolvedValue({ id: BigInt(5), slug: "same-fig" });

    const result = await applyFigureImport(ctx, defaultItem, "item-1", defaultActor, { slug: "same-fig", name: "Same", janCode: "X" }, "figure_import");
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// revision write failure
// ---------------------------------------------------------------------------
describe("revision write failure", () => {
  it("propagates error when prisma.revision.create fails", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "rev-fail" });
    ctx.prisma.revision.findFirst.mockResolvedValue(null);
    ctx.prisma.revision.create.mockRejectedValue(new Error("Constraint violation"));

    await expect(
      applyRewrite(ctx, { ...defaultItem, type: "rewrite", figureSlug: "rev-fail" }, "item-1", defaultActor, { contentMd: "# boom" }, "rewrite"),
    ).rejects.toThrow("Constraint violation");
  });

  it("propagates error when prisma.figure.update (set activeRevision) fails", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "update-fail" });
    ctx.prisma.revision.findFirst.mockResolvedValue(null);
    ctx.prisma.revision.create.mockResolvedValue({ id: BigInt(1), versionNumber: 1 });
    ctx.prisma.figure.update.mockRejectedValue(new Error("Deadlock"));

    await expect(
      applyRewrite(ctx, { ...defaultItem, type: "rewrite", figureSlug: "update-fail" }, "item-1", defaultActor, { contentMd: "# boom" }, "rewrite"),
    ).rejects.toThrow("Deadlock");
  });
});

// ---------------------------------------------------------------------------
// review status write failure
// ---------------------------------------------------------------------------
describe("review status write failure", () => {
  it("throws when redis.set in applyItemStatus fails", async () => {
    const ctx = makeContext();
    ctx.redis.set = vi.fn().mockRejectedValue(new Error("Redis write failed"));
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "status-fail" });

    await expect(
      applyItemStatus(ctx, "item-1", { ...defaultItem, payload: {} }, { success: true, action: "test" }),
    ).rejects.toThrow("Redis write failed");
  });

  it("throws when verifyLock fails during applyItemStatus", async () => {
    const ctx = makeContext();
    ctx.verifyLock = vi.fn().mockRejectedValue(new Error("APPLY_LOCK_LOST"));
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "lock-lost" });

    await expect(
      applyItemStatus(ctx, "item-1", { ...defaultItem, payload: {} }, { success: true, action: "test" }),
    ).rejects.toThrow("APPLY_LOCK_LOST");
  });

  it("sets status to needs_changes when business output has failure", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "check" });

    const status = await applyItemStatus(ctx, "item-1", { ...defaultItem, payload: {} }, {
      success: false, action: "image_failed", failure: { stage: "image_download", problems: ["failed"] },
    });

    expect(status).toBe("needs_changes");
  });

  it("sets status to resolved on clean output", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "clean" });

    const status = await applyItemStatus(ctx, "item-1", { ...defaultItem, payload: {} }, {
      success: true, action: "figure_created",
    });

    expect(status).toBe("resolved");
  });
});

// ---------------------------------------------------------------------------
// BigInt boundary
// ---------------------------------------------------------------------------
describe("BigInt boundary", () => {
  beforeEach(() => {
    vi.mocked(processAndStoreImage).mockReset().mockResolvedValue([]);
  });

  it("serializes figureId at Number.MAX_SAFE_INTEGER as string", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(Number.MAX_SAFE_INTEGER), slug: "max-safe" });

    const result = await applyFigureImport(ctx, defaultItem, "item-1", defaultActor, { slug: "max-safe", name: "Max" }, "figure_import");
    expect(result.figure!.id).toBe("9007199254740991");
  });

  it("serializes figureId beyond Number.MAX_SAFE_INTEGER without precision loss", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt("9007199254740993"), slug: "beyond" });

    const result = await applyFigureImport(ctx, defaultItem, "item-1", defaultActor, { slug: "beyond", name: "Beyond" }, "figure_import");
    expect(result.figure!.id).toBe("9007199254740993");
  });

  it("handles zero BigInt figureId", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(0), slug: "zero" });

    const result = await applyFigureImport(ctx, defaultItem, "item-1", defaultActor, { slug: "zero", name: "Zero" }, "figure_import");
    expect(result.figure!.id).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// JanCode traversal
// ---------------------------------------------------------------------------
describe("JanCode traversal", () => {
  beforeEach(() => {
    vi.mocked(processAndStoreImage).mockReset().mockResolvedValue([]);
  });

  it("jan_match rejects empty janCode", async () => {
    const ctx = makeContext();
    await expect(
      applyJanMatch(ctx, defaultItem, "item-1", defaultActor, { janCode: "" }, "jan_match"),
    ).rejects.toThrow(ApplyValidationError);
  });

  it("jan_match rejects non-existent janCode with FIGURE_NOT_FOUND", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);

    await expect(
      applyJanMatch(ctx, defaultItem, "item-1", defaultActor, { janCode: "NONEXISTENT" }, "jan_match"),
    ).rejects.toThrow(ApplyDependencyError);
  });

  it("figure_import accepts very long janCode string", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(1), slug: "long-jan" });
    const longJan = "JAN" + "x".repeat(1000);

    const result = await applyFigureImport(ctx, defaultItem, "item-1", defaultActor, { slug: "long-jan", name: "Long", janCode: longJan }, "figure_import");
    expect(result.success).toBe(true);
    expect(ctx.prisma.figure.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ janCode: longJan }) }),
    );
  });

  it("figure_import accepts special characters in janCode", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(1), slug: "special-jan" });

    await applyFigureImport(ctx, defaultItem, "item-1", defaultActor, { slug: "special-jan", name: "S", janCode: "!@#$%^&*()_+=" }, "figure_import");
    expect(ctx.prisma.figure.create).toHaveBeenCalled();
  });

  it("figure_import accepts undefined janCode", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(1), slug: "no-jan" });

    const result = await applyFigureImport(ctx, defaultItem, "item-1", defaultActor, { slug: "no-jan", name: "No JAN" } as any, "figure_import");
    expect(result.success).toBe(true);
    expect(ctx.prisma.figure.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ janCode: null }) }),
    );
  });

  it("figure_import passes janCode through to prisma create", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(1), slug: "pass-jan" });

    await applyFigureImport(ctx, defaultItem, "item-1", defaultActor, { slug: "pass-jan", name: "Pass", janCode: "ABC-123" }, "figure_import");
    expect(ctx.prisma.figure.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ janCode: "ABC-123" }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// SSRF prevention marker
// ---------------------------------------------------------------------------
describe("SSRF prevention — image URL validation", () => {
  it("passes the user-supplied source URL to processAndStoreImage", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue({ id: BigInt(1), slug: "ssrf", janCode: "j123" });
    vi.mocked(processAndStoreImage).mockResolvedValue([
      { sha256: "ssrf1", janCode: "j123", size: "raw", format: "png", width: 100, height: 100, fileSize: 500, alt: undefined, sortOrder: 0, source: "http://evil.com/ssrf.jpg", isNsfw: false },
    ]);
    vi.mocked(upsertFigureImageRecord).mockResolvedValue({ image: { id: BigInt(1) } } as any);

    await applyImage(ctx, { ...defaultItem, type: "image", figureSlug: "ssrf" }, "item-1", defaultActor, { source: "http://evil.com/ssrf.jpg" }, "image");

    expect(vi.mocked(processAndStoreImage)).toHaveBeenCalledWith(
      "http://evil.com/ssrf.jpg", expect.any(String), expect.anything(), expect.anything(),
    );
    // The actual URL validation occurs inside processAndStoreImage → validateImageUrl;
    // this test asserts the URL is forwarded so validation can happen downstream.
  });

  it("passes image URLs through applyFigureImport to processAndStoreImage", async () => {
    const ctx = makeContext();
    ctx.prisma.figure.findFirst.mockResolvedValue(null);
    ctx.prisma.figure.create.mockResolvedValue({ id: BigInt(1), slug: "ssrf-fig", janCode: "j123" });
    vi.mocked(processAndStoreImage).mockResolvedValue([]);

    await applyFigureImport(ctx, defaultItem, "item-1", defaultActor, {
      slug: "ssrf-fig", name: "SSRF", janCode: "j123",
      images: [{ source: "http://malicious.example.com/img.jpg" }],
    }, "figure_import");

    expect(vi.mocked(processAndStoreImage)).toHaveBeenCalledWith(
      "http://malicious.example.com/img.jpg", expect.any(String), expect.anything(), expect.anything(),
    );
  });
});
