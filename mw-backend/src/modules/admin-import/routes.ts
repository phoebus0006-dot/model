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
    const schema = z.object({
      figures: z.array(z.object({
        slug: z.string().min(1), name: z.string().min(1), nameJp: z.string().optional(), nameEn: z.string().optional(),
        scale: z.string().optional(), material: z.string().optional(), priceJpy: z.number().int().optional(),
        releaseDate: z.string().optional(), heightMm: z.number().int().optional(),
        seriesSlug: z.string().optional(), manufacturerSlug: z.string().optional(), mfcId: z.string().optional(),
        images: z.array(z.object({ url: z.string().url(), alt: z.string().optional(), source: z.string().optional() })).optional(),
      })).min(1).max(100),
    });
    const data = schema.parse(req.body);
    const results: Array<{ slug: string; status: string; id?: string; error?: string; stage?: string }> = [];
    let totalFailed = 0;
    let totalPartial = 0;
    let totalCreated = 0;

    for (const fig of data.figures) {
      try {
        const existing = await app.prisma.figure.findFirst({ where: { slug: fig.slug } });
        if (existing) {
          results.push({ slug: fig.slug, status: "skipped_exists", id: String(existing.id) });
          continue;
        }
        let seriesId: bigint | undefined;
        if (fig.seriesSlug) { const s = await app.prisma.series.findUnique({ where: { slug: fig.seriesSlug } }); seriesId = s?.id; }
        let manufacturerId: bigint | undefined;
        if (fig.manufacturerSlug) { const m = await app.prisma.manufacturer.findUnique({ where: { slug: fig.manufacturerSlug } }); manufacturerId = m?.id; }
        const { images, seriesSlug, manufacturerSlug, ...figureData } = fig;
        const figure = await app.prisma.figure.create({
          data: { ...figureData, seriesId, manufacturerId, releaseDate: fig.releaseDate ? new Date(fig.releaseDate) : undefined },
        });
        const janCode = figure.janCode || "";
        const imagesArray = images || [];

        if (imagesArray.length === 0) {
          results.push({ slug: fig.slug, status: "created", id: String(figure.id) });
          totalCreated++;
          continue;
        }

        let imageErrors = 0;
        for (let i = 0; i < imagesArray.length; i++) {
          const img = imagesArray[i];
          if (!janCode) { imageErrors++; continue; }
          try {
            await processAndStoreImage(img.url, janCode, app.prisma, {
              alt: img.alt || fig.name, sortOrder: i, figureId: figure.id,
            });
          } catch (err: any) {
            imageErrors++;
            app.log.error({ err, url: img.url, figureId: String(figure.id) }, "Image processing failed during legacy import");
          }
        }

        if (imageErrors === imagesArray.length) {
          results.push({ slug: fig.slug, status: "failed", id: String(figure.id), stage: "image", error: "All images failed" });
          totalFailed++;
        } else if (imageErrors > 0) {
          results.push({ slug: fig.slug, status: "partial_failed", id: String(figure.id), stage: "image", error: `${imageErrors}/${imagesArray.length} images failed` });
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
    return {
      success: true, data: {
        total: data.figures.length, created: totalCreated, failed: totalFailed, partial_failed: totalPartial, results, stage: totalFailed === data.figures.length ? "failed" : totalPartial > 0 ? "partial_failed" : "created",
      },
    };
  });
}
