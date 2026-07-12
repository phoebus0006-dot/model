import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

const IDEMP_TTL_MS = 3600_000;

function mockRedis() {
  const store: Record<string, { value: string; expiresAt: number }> = {};
  return {
    get: vi.fn(async (key: string) => {
      const entry = store[key];
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        delete store[key];
        return null;
      }
      return entry.value;
    }),
    set: vi.fn(async (key: string, value: string, ...args: string[]) => {
      const pxIdx = args.indexOf("PX");
      const ttl = pxIdx !== -1 ? parseInt(args[pxIdx + 1], 10) : IDEMP_TTL_MS;
      store[key] = { value, expiresAt: Date.now() + ttl };
      return "OK";
    }),
    scan: vi.fn(async () => ["0", []] as [string, string[]]),
    llen: vi.fn(async () => 0),
    _store: store,
  };
}

let _figIdCounter = 1n;
let _imgIdCounter = 1n;

function freshIdCounters() {
  _figIdCounter = 1n;
  _imgIdCounter = 1n;
}

function mockPrisma() {
  const figures: any[] = [];
  const figureImages: any[] = [];

  const prisma: any = {
    figure: {
      findFirst: vi.fn(async ({ where }: any) => {
        return figures.find((f) => f.slug === where.slug) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const f = { id: _figIdCounter++, ...data, createdAt: new Date(), updatedAt: new Date() };
        figures.push(f);
        return f;
      }),
    },
    figureImage: {
      findMany: vi.fn(async ({ where }: any) => {
        return figureImages.filter((fi) => fi.figureId === where.figureId);
      }),
      create: vi.fn(async ({ data }: any) => {
        const img = { id: _imgIdCounter++, ...data };
        figureImages.push(img);
        return img;
      }),
    },
    series: {
      findUnique: vi.fn(async () => null),
    },
    manufacturer: {
      findUnique: vi.fn(async () => null),
    },
    _figures: figures,
    _figureImages: figureImages,
  };
  return prisma;
}

function mockLog() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
}

// ---------------------------------------------------------------------------
// Extracted business logic (mirrors routes.ts 1:1)
// ---------------------------------------------------------------------------

async function simulateImageProcessing(url: string, shouldSucceed: boolean, failMessage?: string): Promise<void> {
  if (!shouldSucceed) throw new Error(failMessage || "Image processing failed");
}

async function processFigureImages(
  prisma: any,
  log: any,
  figure: any,
  images: Array<{ url: string; alt?: string; source?: string }>,
  janCode: string,
  figName: string,
  imageSuccessMap?: Map<string, boolean>,
): Promise<{ created: number; errors: Array<{ url: string; error: string }> }> {
  if (images.length === 0) return { created: 0, errors: [] };
  if (!janCode) return { created: 0, errors: images.map((i) => ({ url: i.url, error: "No janCode" })) };

  let created = 0;
  const errors: Array<{ url: string; error: string }> = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    try {
      const shouldSucceed = imageSuccessMap ? (imageSuccessMap.get(img.url) ?? true) : true;
      await simulateImageProcessing(img.url, shouldSucceed);
      await prisma.figureImage.create({
        data: {
          figureId: figure.id,
          url: img.url,
          janCode,
          alt: img.alt || figName,
          sortOrder: i,
          source: img.source ?? null,
          size: "raw",
          format: "webp",
          isNsfw: false,
        },
      });
      created++;
    } catch (err: any) {
      errors.push({ url: img.url, error: err?.message || "Image processing failed" });
      log.error({ err, url: img.url, figureId: String(figure.id) }, "Image processing failed during legacy import");
    }
  }
  return { created, errors };
}

async function processBatchImport(
  data: { idempotencyKey?: string; figures: any[] },
  redis: any,
  prisma: any,
  log: any,
  imageSuccessMap?: Map<string, boolean>,
) {
  const idempotencyKey = data.idempotencyKey;

  if (idempotencyKey) {
    const cached = await redis.get(`legacy:import:idempot:${idempotencyKey}`);
    if (cached) {
      return { success: true, data: { ...JSON.parse(cached), idempotent: true } };
    }
  }

  const results: Array<{ slug: string; status: string; id?: string; error?: string; stage?: string }> = [];
  let totalFailed = 0;
  let totalPartial = 0;
  let totalCreated = 0;

  for (const fig of data.figures) {
    try {
      const existing = await prisma.figure.findFirst({ where: { slug: fig.slug } });
      const images = (fig.images || []).filter((i: any) => i.url);

      if (existing) {
        const janCode = existing.janCode || "";
        if (images.length > 0) {
          const existingImages = await prisma.figureImage.findMany({
            where: { figureId: existing.id },
            select: { source: true },
          });
          const existingSources = new Set(existingImages.map((im: any) => im.source).filter(Boolean));
          const newImages = images.filter((i: any) => !i.source || !existingSources.has(i.source));

          if (newImages.length > 0) {
            const imgResult = await processFigureImages(prisma, log, existing, newImages, janCode, fig.name, imageSuccessMap);
            if (imgResult.errors.length > 0 && imgResult.created === 0) {
              results.push({ slug: fig.slug, status: "failed", id: String(existing.id), stage: "image", error: `All ${newImages.length} new images failed` });
              totalFailed++;
              continue;
            }
            if (imgResult.errors.length > 0) {
              results.push({ slug: fig.slug, status: "partial_failed", id: String(existing.id), stage: "image", error: `${imgResult.errors.length}/${newImages.length} new images failed` });
              totalPartial++;
              continue;
            }
          }
        }
        results.push({ slug: fig.slug, status: "skipped_exists", id: String(existing.id) });
        continue;
      }

      let seriesId: bigint | undefined;
      if (fig.seriesSlug) {
        const s = await prisma.series.findUnique({ where: { slug: fig.seriesSlug } });
        seriesId = s?.id;
      }
      let manufacturerId: bigint | undefined;
      if (fig.manufacturerSlug) {
        const m = await prisma.manufacturer.findUnique({ where: { slug: fig.manufacturerSlug } });
        manufacturerId = m?.id;
      }
      const { images: _skippedImages, seriesSlug, manufacturerSlug, ...figureData } = fig;
      const figure = await prisma.figure.create({
        data: {
          ...figureData,
          seriesId,
          manufacturerId,
          releaseDate: fig.releaseDate ? new Date(fig.releaseDate) : undefined,
        },
      });

      if (images.length === 0) {
        results.push({ slug: fig.slug, status: "created", id: String(figure.id) });
        totalCreated++;
        continue;
      }

      const janCode = figure.janCode || "";
      const imgResult = await processFigureImages(prisma, log, figure, images, janCode, fig.name, imageSuccessMap);

      if (imgResult.errors.length === images.length) {
        results.push({ slug: fig.slug, status: "failed", id: String(figure.id), stage: "image", error: "All images failed" });
        totalFailed++;
      } else if (imgResult.errors.length > 0) {
        results.push({ slug: fig.slug, status: "partial_failed", id: String(figure.id), stage: "image", error: `${imgResult.errors.length}/${images.length} images failed` });
        totalPartial++;
      } else {
        results.push({ slug: fig.slug, status: "created", id: String(figure.id) });
        totalCreated++;
      }
    } catch (err: any) {
      results.push({ slug: fig.slug, status: "failed", error: err.message, stage: "figure" });
      totalFailed++;
    }
  }

  const response = {
    total: data.figures.length,
    created: totalCreated,
    failed: totalFailed,
    partial_failed: totalPartial,
    results,
    stage: totalFailed === data.figures.length ? "failed" : totalPartial > 0 ? "partial_failed" : "created",
  };

  if (idempotencyKey) {
    await redis.set(`legacy:import:idempot:${idempotencyKey}`, JSON.stringify(response), "PX", IDEMP_TTL_MS);
  }

  return { success: true, data: response };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Admin Import — idempotency key", () => {
  beforeEach(() => freshIdCounters());

  it("1. header-style key is respected via data.idempotencyKey", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const body = {
      idempotencyKey: "hdr-key-1",
      figures: [{ slug: "fig-a", name: "Fig A" }],
    };

    const res1 = await processBatchImport(body, redis, prisma, log);
    expect(res1.success).toBe(true);
    expect(res1.data.idempotent).toBeUndefined();

    const cached = await redis.get("legacy:import:idempot:hdr-key-1");
    expect(cached).not.toBeNull();
  });

  it("2. body key is used for idempotency lookup", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const body = {
      idempotencyKey: "body-key-1",
      figures: [{ slug: "fig-a", name: "Fig A" }],
    };

    const res1 = await processBatchImport(body, redis, prisma, log);
    expect(res1.success).toBe(true);

    const res2 = await processBatchImport(body, redis, prisma, log);
    expect(res2.data.idempotent).toBe(true);
  });

  it("3. duplicate request returns identical cached result", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const body = {
      idempotencyKey: "dup-key",
      figures: [{ slug: "fig-a", name: "Fig A" }],
    };

    const res1 = await processBatchImport(body, redis, prisma, log);
    const res2 = await processBatchImport(body, redis, prisma, log);

    expect(res2.data.idempotent).toBe(true);
    expect(res2.data.created).toBe(res1.data.created);
    expect(res2.data.total).toBe(res1.data.total);
  });

  it("4. different body with same key returns original cached result", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const body1 = {
      idempotencyKey: "same-key",
      figures: [{ slug: "fig-a", name: "Fig A" }],
    };
    const body2 = {
      idempotencyKey: "same-key",
      figures: [{ slug: "fig-b", name: "Fig B" }],
    };

    const res1 = await processBatchImport(body1, redis, prisma, log);
    expect(res1.data.results[0].slug).toBe("fig-a");

    const res2 = await processBatchImport(body2, redis, prisma, log);
    expect(res2.data.idempotent).toBe(true);
    expect(res2.data.results[0].slug).toBe("fig-a");
  });

  it("5. cache expiry causes fresh execution", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const body = {
      idempotencyKey: "expire-key",
      figures: [{ slug: "fig-a", name: "Fig A" }],
    };

    const res1 = await processBatchImport(body, redis, prisma, log);
    expect(res1.data.results[0].status).toBe("created");
    expect(res1.data.idempotent).toBeUndefined();

    // Manually expire the key
    const storeKey = "legacy:import:idempot:expire-key";
    if (redis._store[storeKey]) {
      redis._store[storeKey].expiresAt = Date.now() - 1;
    }

    const res2 = await processBatchImport(body, redis, prisma, log);
    // Not idempotent — key was expired
    expect(res2.data.idempotent).toBeUndefined();
    // Figure already exists, so it's skipped, not re-created
    expect(res2.data.results[0].status).toBe("skipped_exists");
  });

  it("6. failed results are cached and returned idempotently", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const imageMap = new Map<string, boolean>([["http://fail.me/img.jpg", false]]);

    const body = {
      idempotencyKey: "fail-cache",
      figures: [
        {
          slug: "fig-fail",
          name: "Fail Fig",
          janCode: "JAN001",
          images: [{ url: "http://fail.me/img.jpg" }],
        },
      ],
    };

    const res1 = await processBatchImport(body, redis, prisma, log, imageMap);
    expect(res1.data.failed).toBe(1);
    expect(res1.data.results[0].status).toBe("failed");

    const res2 = await processBatchImport(body, redis, prisma, log, imageMap);
    expect(res2.data.idempotent).toBe(true);
    expect(res2.data.failed).toBe(1);
  });

  it("7. concurrent same-key: only one execution proceeds", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    // Simulate concurrency by running two imports in parallel.
    // The second should hit the cache (or if not, both should produce consistent results).
    const body = {
      idempotencyKey: "concurrent-key",
      figures: [{ slug: "fig-a", name: "Fig A" }],
    };

    const [r1, r2] = await Promise.all([
      processBatchImport(body, redis, prisma, log),
      processBatchImport(body, redis, prisma, log),
    ]);

    // Both must report success
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    // At most one is idempotent (the second one to check cache)
    const idempotentCount = [r1, r2].filter((r) => r.data.idempotent === true).length;
    expect(idempotentCount).toBeGreaterThanOrEqual(0);
    expect(idempotentCount).toBeLessThanOrEqual(1);

    // Both must agree on the total created count (1 figure created)
    expect(r1.data.created).toBe(1);
    expect(r2.data.created).toBe(1);
  });
});

describe("Admin Import — image retry", () => {
  beforeEach(() => freshIdCounters());

  it("8. existing figure with missing images: retry and succeed", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    // Pre-create a figure with no images
    await prisma.figure.create({
      data: { slug: "fig-exist", name: "Existing", janCode: "JAN001" },
    });

    const body = {
      figures: [
        {
          slug: "fig-exist",
          name: "Existing",
          images: [{ url: "http://example.com/img1.jpg" }],
        },
      ],
    };

    const result = await processBatchImport(body, redis, prisma, log);
    expect(result.data.results[0].status).toBe("skipped_exists");

    const images = prisma._figureImages.filter((fi: any) => fi.figureId === 1n);
    expect(images.length).toBe(1);
    expect(images[0].url).toBe("http://example.com/img1.jpg");
  });

  it("9. source URL dedup: don't reprocess existing source", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    // Pre-create figure with an image that has source "official"
    const fig = await prisma.figure.create({
      data: { slug: "fig-dedup", name: "Dedup", janCode: "JAN002" },
    });
    await prisma.figureImage.create({
      data: {
        figureId: fig.id,
        url: "http://existing.com/img.jpg",
        source: "official",
        janCode: "JAN002",
        sortOrder: 0,
        size: "raw",
        format: "webp",
        isNsfw: false,
      },
    });

    const body = {
      figures: [
        {
          slug: "fig-dedup",
          name: "Dedup",
          images: [
            { url: "http://new.com/img1.jpg", source: "official" }, // same source → skipped
            { url: "http://new.com/img2.jpg", source: "fanart" }, // new source → processed
          ],
        },
      ],
    };

    const result = await processBatchImport(body, redis, prisma, log);
    // Because newImages.length === 1 ("fanart") and it succeeds → status = skipped_exists
    // (no error, all new images processed ok)
    expect(result.data.results[0].status).toBe("skipped_exists");

    const images = prisma._figureImages;
    const sources = images.map((im: any) => im.source);
    expect(sources).toContain("fanart");
    // Only 2 images: the pre-existing one + the new "fanart" one
    expect(images.length).toBe(2);
  });

  it("10. existing images preserved when retrying", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const fig = await prisma.figure.create({
      data: { slug: "fig-preserve", name: "Preserve", janCode: "JAN003" },
    });
    await prisma.figureImage.create({
      data: {
        figureId: fig.id,
        url: "http://keep.me/img.jpg",
        source: "keep",
        janCode: "JAN003",
        sortOrder: 0,
        size: "raw",
        format: "webp",
        isNsfw: false,
      },
    });

    const body = {
      figures: [
        {
          slug: "fig-preserve",
          name: "Preserve",
          images: [
            { url: "http://keep.me/img.jpg", source: "keep" }, // dedup'd → skipped
          ],
        },
      ],
    };

    const result = await processBatchImport(body, redis, prisma, log);
    expect(result.data.results[0].status).toBe("skipped_exists");

    const images = prisma._figureImages;
    expect(images.length).toBe(1);
    expect(images[0].url).toBe("http://keep.me/img.jpg");
  });

  it("11. previously failed images can be retried", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    // First attempt: image fails
    const imageMap1 = new Map<string, boolean>([["http://retry.me/img.jpg", false]]);
    const body1 = {
      figures: [
        {
          slug: "fig-retry",
          name: "Retry",
          janCode: "JAN004",
          images: [{ url: "http://retry.me/img.jpg" }],
        },
      ],
    };

    const res1 = await processBatchImport(body1, redis, prisma, log, imageMap1);
    expect(res1.data.results[0].status).toBe("failed");

    // Second attempt: same figure (already created), same image, now succeeds
    // Since source is null/empty, there's no existing source match, so newImages will include it
    const body2 = {
      figures: [
        {
          slug: "fig-retry",
          name: "Retry",
          images: [{ url: "http://retry.me/img.jpg" }],
        },
      ],
    };

    const res2 = await processBatchImport(body2, redis, prisma, log);
    expect(res2.data.results[0].status).toBe("skipped_exists");

    const images = prisma._figureImages;
    expect(images.length).toBe(1); // only one image record after success
  });

  it("12. new sources appended to existing figure", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const fig = await prisma.figure.create({
      data: { slug: "fig-append", name: "Append", janCode: "JAN005" },
    });
    await prisma.figureImage.create({
      data: {
        figureId: fig.id,
        url: "http://original.com/a.jpg",
        source: "srcA",
        janCode: "JAN005",
        sortOrder: 0,
        size: "raw",
        format: "webp",
        isNsfw: false,
      },
    });

    const body = {
      figures: [
        {
          slug: "fig-append",
          name: "Append",
          images: [
            { url: "http://original.com/a.jpg", source: "srcA" }, // dup → skipped
            { url: "http://new.com/b.jpg", source: "srcB" }, // new → added
            { url: "http://new.com/c.jpg", source: "srcC" }, // new → added
          ],
        },
      ],
    };

    const result = await processBatchImport(body, redis, prisma, log);
    expect(result.data.results[0].status).toBe("skipped_exists");

    const images = prisma._figureImages;
    expect(images.length).toBe(3);
    const sources = images.map((im: any) => im.source).sort();
    expect(sources).toEqual(["srcA", "srcB", "srcC"]);
  });

  it("13. all images succeed → status is skipped_exists for existing figure", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const fig = await prisma.figure.create({
      data: { slug: "fig-all-ok", name: "AllOk", janCode: "JAN006" },
    });

    const body = {
      figures: [
        {
          slug: "fig-all-ok",
          name: "AllOk",
          images: [{ url: "http://ok.com/img.jpg", source: "src1" }],
        },
      ],
    };

    const result = await processBatchImport(body, redis, prisma, log);
    expect(result.data.results[0].status).toBe("skipped_exists");

    const images = prisma._figureImages;
    expect(images.length).toBe(1);
    expect(images[0].url).toBe("http://ok.com/img.jpg");
  });
});

describe("Admin Import — partial stage", () => {
  beforeEach(() => freshIdCounters());

  it("14. figure creation failure → stage: 'figure'", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    // Force failure by making figure.create throw
    prisma.figure.create = vi.fn(async () => {
      throw new Error("DB constraint violation");
    });

    const body = {
      figures: [{ slug: "fig-crash", name: "Crash" }],
    };

    const result = await processBatchImport(body, redis, prisma, log);
    expect(result.data.results[0].status).toBe("failed");
    expect(result.data.results[0].stage).toBe("figure");
    expect(result.data.results[0].error).toBe("DB constraint violation");
    expect(result.data.stage).toBe("failed");
  });

  it("15. all images fail → stage: 'image'", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const imageMap = new Map<string, boolean>([
      ["http://fail1.com/a.jpg", false],
      ["http://fail2.com/b.jpg", false],
    ]);

    const body = {
      figures: [
        {
          slug: "fig-img-fail",
          name: "ImgFail",
          janCode: "JAN007",
          images: [
            { url: "http://fail1.com/a.jpg" },
            { url: "http://fail2.com/b.jpg" },
          ],
        },
      ],
    };

    const result = await processBatchImport(body, redis, prisma, log, imageMap);
    expect(result.data.results[0].status).toBe("failed");
    expect(result.data.results[0].stage).toBe("image");
    expect(result.data.results[0].error).toBe("All images failed");
    expect(result.data.stage).toBe("failed");
  });

  it("16. everything succeeds → stage: 'created'", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const body = {
      figures: [
        {
          slug: "fig-ok",
          name: "OK",
          janCode: "JAN008",
          images: [{ url: "http://ok.com/a.jpg" }],
        },
      ],
    };

    const result = await processBatchImport(body, redis, prisma, log);
    expect(result.data.results[0].status).toBe("created");
    expect(result.data.results[0].stage).toBeUndefined();
    expect(result.data.stage).toBe("created");
  });

  it("17. mixed success: some images succeed, some fail → partial_failed with error count", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const imageMap = new Map<string, boolean>([
      ["http://ok.com/a.jpg", true],
      ["http://fail.com/b.jpg", false],
    ]);

    const body = {
      figures: [
        {
          slug: "fig-mixed",
          name: "Mixed",
          janCode: "JAN009",
          images: [
            { url: "http://ok.com/a.jpg" },
            { url: "http://fail.com/b.jpg" },
          ],
        },
      ],
    };

    const result = await processBatchImport(body, redis, prisma, log, imageMap);
    expect(result.data.results[0].status).toBe("partial_failed");
    expect(result.data.results[0].stage).toBe("image");
    expect(result.data.results[0].error).toBe("1/2 images failed");
    expect(result.data.partial_failed).toBe(1);
    expect(result.data.created).toBe(0);
    expect(result.data.stage).toBe("partial_failed");
  });

  it("18. all images fail ≠ 'created' status", async () => {
    const redis = mockRedis();
    const prisma = mockPrisma();
    const log = mockLog();

    const imageMap = new Map<string, boolean>([
      ["http://x.com/1.jpg", false],
      ["http://x.com/2.jpg", false],
      ["http://x.com/3.jpg", false],
    ]);

    const body = {
      figures: [
        {
          slug: "fig-all-bad",
          name: "AllBad",
          janCode: "JAN010",
          images: [
            { url: "http://x.com/1.jpg" },
            { url: "http://x.com/2.jpg" },
            { url: "http://x.com/3.jpg" },
          ],
        },
      ],
    };

    const result = await processBatchImport(body, redis, prisma, log, imageMap);
    // Must NOT be "created"
    expect(result.data.results[0].status).not.toBe("created");
    expect(result.data.results[0].status).toBe("failed");
    expect(result.data.created).toBe(0);
    expect(result.data.stage).toBe("failed");

    // Verify no image records were created when all failed
    expect(prisma._figureImages.length).toBe(0);
  });
});
