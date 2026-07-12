import { FastifyInstance } from "fastify";
import { z } from "zod";
import { processAndStoreImage, upsertFigureImageRecord } from "../../modules/images/image-service.js";
import { scanKeys } from "../../shared/cache/scan-keys.js";

function isEnabled() {
  return process.env.ENABLE_LEGACY_ADMIN_IMPORTS === "true";
}

function disabled(reply: any) {
  return reply.status(410).send({
    success: false,
    error: { code: "LEGACY_IMPORT_DISABLED", message: "Legacy admin import endpoints are disabled" },
  });
}

const importRequestSchema = z.object({
  idempotencyKey: z.string().min(1).max(128).optional(),
  figures: z.array(z.object({
    slug: z.string().min(1), name: z.string().min(1), nameJp: z.string().optional(), nameEn: z.string().optional(),
    scale: z.string().optional(), material: z.string().optional(), priceJpy: z.number().int().optional(),
    releaseDate: z.string().optional(), heightMm: z.number().int().optional(),
    seriesSlug: z.string().optional(), manufacturerSlug: z.string().optional(), mfcId: z.string().optional(),
    images: z.array(z.object({ url: z.string().url(), alt: z.string().optional(), source: z.string().optional() })).optional(),
  })).min(1).max(100),
});

async function processFigureImages(
  prisma: any, log: any, figure: any, images: Array<{ url: string; alt?: string; source?: string }>, janCode: string, figName: string,
): Promise<{ created: number; errors: Array<{ url: string; error: string }> }> {
  if (images.length === 0) return { created: 0, errors: [] };
  if (!janCode) return { created: 0, errors: images.map(i => ({ url: i.url, error: "No janCode" })) };

  let created = 0;
  const errors: Array<{ url: string; error: string }> = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    try {
      await processAndStoreImage(img.url, janCode, prisma, {
        alt: img.alt || figName, sortOrder: i, figureId: figure.id,
      });
      created++;
    } catch (err: any) {
      errors.push({ url: img.url, error: err?.message || "Image processing failed" });
      log.error({ err, url: img.url, figureId: String(figure.id) }, "Image processing failed during legacy import");
    }
  }

  return { created, errors };
}

const IDEMP_TTL_MS = 3600_000;

export async function adminImportRoutes(app: FastifyInstance) {
  app.get("/import/status", async (_req: any, reply: any) => {
    if (!isEnabled()) return disabled(reply);
    const queueLen = await app.redis.llen("legacy:import:queue");
    const processing = await app.redis.get("legacy:import:processing");
    const recentImports: Array<{ itemId: number; status: string }> = [];
    const recentKeys: string[] = [];
    let cursor = "0";
    do {
      const [nc, ks] = await app.redis.scan(cursor, "MATCH", "legacy:import:result:*", "COUNT", "100");
      cursor = nc;
      for (const k of ks) recentKeys.push(k);
    } while (cursor !== "0");
    for (const key of recentKeys.slice(-10)) {
      const val = await app.redis.get(key);
      if (val) { try { recentImports.push(JSON.parse(val)); } catch {} }
    }
    return {
      success: true,
      data: { queueLength: queueLen, isProcessing: !!processing, currentJob: processing ? JSON.parse(processing) : null, recentImports },
    };
  });

  app.post("/figures/batch", async (req: any, reply: any) => {
    if (!isEnabled()) return disabled(reply);
    const data = importRequestSchema.parse(req.body);

    const idempotencyKey = data.idempotencyKey || (req.headers as any)["idempotency-key"];
    if (idempotencyKey) {
      const cached = await app.redis.get(`legacy:import:idempot:${idempotencyKey}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        return reply.status(200).send({ success: true, data: { ...parsed, idempotent: true } });
      }
    }

    const results: Array<{ slug: string; status: string; id?: string; error?: string; stage?: string }> = [];
    let totalFailed = 0;
    let totalPartial = 0;
    let totalCreated = 0;

    for (const fig of data.figures) {
      try {
        const existing = await app.prisma.figure.findFirst({ where: { slug: fig.slug } });
        const images = (fig.images || []).filter(i => i.url);

        if (existing) {
          const janCode = existing.janCode || "";
          if (images.length > 0) {
            const existingImages = await app.prisma.figureImage.findMany({
              where: { figureId: existing.id },
              select: { source: true },
            });
            const existingSources = new Set(existingImages.map((im: any) => im.source).filter(Boolean));
            const newImages = images.filter(i => !i.source || !existingSources.has(i.source));

            if (newImages.length > 0) {
              const imgResult = await processFigureImages(app.prisma, app.log, existing, newImages, janCode, fig.name);
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
        if (fig.seriesSlug) { const s = await app.prisma.series.findUnique({ where: { slug: fig.seriesSlug } }); seriesId = s?.id; }
        let manufacturerId: bigint | undefined;
        if (fig.manufacturerSlug) { const m = await app.prisma.manufacturer.findUnique({ where: { slug: fig.manufacturerSlug } }); manufacturerId = m?.id; }
        const { images: _skippedImages, seriesSlug, manufacturerSlug, ...figureData } = fig;
        const figure = await app.prisma.figure.create({
          data: { ...figureData, seriesId, manufacturerId, releaseDate: fig.releaseDate ? new Date(fig.releaseDate) : undefined },
        });

        if (images.length === 0) {
          results.push({ slug: fig.slug, status: "created", id: String(figure.id) });
          totalCreated++;
          continue;
        }

        const janCode = figure.janCode || "";
        const imgResult = await processFigureImages(app.prisma, app.log, figure, images, janCode, fig.name);

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

    await scanKeys(app.redis, "figures:*");

    const response = {
      total: data.figures.length, created: totalCreated, failed: totalFailed, partial_failed: totalPartial, results,
      stage: totalFailed === data.figures.length ? "failed" : totalPartial > 0 ? "partial_failed" : "created",
    };

    if (idempotencyKey) {
      await app.redis.set(`legacy:import:idempot:${idempotencyKey}`, JSON.stringify(response), "PX", IDEMP_TTL_MS);
    }

    return { success: true, data: response };
  });
}
