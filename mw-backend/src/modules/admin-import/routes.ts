import { FastifyInstance } from "fastify";
import { z } from "zod";
import { processAndStoreImage, upsertFigureImageRecord } from "../../routes/images.js";
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
    const results: Array<{ slug: string; status: string; id?: string; error?: string }> = [];
    for (const fig of data.figures) {
      try {
        const existing = await app.prisma.figure.findFirst({ where: { slug: fig.slug } });
        if (existing) { results.push({ slug: fig.slug, status: "skipped_exists", id: String(existing.id) }); continue; }
        let seriesId: bigint | undefined;
        if (fig.seriesSlug) { const s = await app.prisma.series.findUnique({ where: { slug: fig.seriesSlug } }); seriesId = s?.id; }
        let manufacturerId: bigint | undefined;
        if (fig.manufacturerSlug) { const m = await app.prisma.manufacturer.findUnique({ where: { slug: fig.manufacturerSlug } }); manufacturerId = m?.id; }
        const { images, seriesSlug, manufacturerSlug, ...figureData } = fig;
        const figure = await app.prisma.figure.create({
          data: { ...figureData, seriesId, manufacturerId, releaseDate: fig.releaseDate ? new Date(fig.releaseDate) : undefined },
        });
        if (images && images.length > 0) {
          const janCode = figure.janCode || "";
          for (let i = 0; i < images.length; i++) {
            const img = images[i];
            if (!janCode) continue;
            try {
              const imageRecords = await processAndStoreImage(img.url, janCode, { alt: img.alt || fig.name, sortOrder: i });
              for (const rec of imageRecords) {
                await upsertFigureImageRecord(app, { figureId: figure.id, janCode: rec.janCode, sha256: rec.sha256, size: rec.size, format: rec.format, width: rec.width, height: rec.height, fileSize: rec.fileSize, alt: rec.alt || null, sortOrder: rec.sortOrder, source: rec.source, isNsfw: rec.isNsfw || false });
              }
            } catch (err: any) { app.log.error({ err, url: img.url }, "Failed to process image during admin import"); }
          }
        }
        results.push({ slug: fig.slug, status: "created", id: String(figure.id) });
      } catch (err: any) { results.push({ slug: fig.slug, status: "error", error: err.message }); }
    }
    await scanKeys(app.redis, "figures:*");
    return { success: true, data: { total: data.figures.length, results } };
  });
}
