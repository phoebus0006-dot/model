import { FastifyInstance } from "fastify";
import { z } from "zod";
import { scanKeys } from "../shared/cache/scan-keys.js";

const listQuery = z.object({
  page: z.coerce.number().min(1).default(1),
  perPage: z.coerce.number().min(1).max(100).default(50),
});

const createSculptorSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  nameJp: z.string().optional(),
  nameEn: z.string().optional(),
  alias: z.array(z.string()).optional(),
  styleTags: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const updateSculptorSchema = createSculptorSchema.partial();

async function invalidateSculptorCache(app: FastifyInstance, slug?: string) {
  if (slug) {
    await app.redis.del(`sculptors:detail:${slug}`);
  }
  await scanKeys(app.redis, "sculptors:list:*");
}

export async function sculptorRoutes(app: FastifyInstance) {
  app.get("/", async (req: any) => {
    const query = listQuery.parse(req.query);
    const cacheKey = `sculptors:list:${query.page}:${query.perPage}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const [data, total] = await Promise.all([
      app.prisma.sculptor.findMany({
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { name: "asc" },
        include: { _count: { select: { figures: true } } },
      }),
      app.prisma.sculptor.count(),
    ]);

    const result = { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 600);
    return result;
  });

  app.get("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const cacheKey = `sculptors:detail:${slug}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const sculptor = await app.prisma.sculptor.findUnique({
      where: { slug },
      include: { _count: { select: { figures: true } } },
    });
    if (!sculptor) return reply.status(404).send({ success: false, error: { code: "SCULPTOR_NOT_FOUND" } });

    const result = { success: true, data: sculptor };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
    return result;
  });

  app.get("/:slug/figures", async (req: any) => {
    const { slug } = req.params as { slug: string };
    const query = listQuery.parse(req.query);
    const sculptor = await app.prisma.sculptor.findUnique({ where: { slug }, select: { id: true } });
    if (!sculptor) return { success: true, data: [], meta: { page: 1, perPage: 24, total: 0, totalPages: 0 } };

    const [data, total] = await Promise.all([
      app.prisma.figure.findMany({
        where: { sculptors: { some: { sculptorId: sculptor.id } }, isDeleted: false },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { releaseDate: "desc" },
        include: {
          manufacturer: { select: { id: true, slug: true, name: true, nameEn: true } },
          series: { select: { id: true, slug: true, name: true, nameEn: true } },
          images: { orderBy: { sortOrder: "asc" }, take: 1, select: { id: true, alt: true, size: true, format: true } },
          categories: { include: { category: { select: { slug: true, name: true } } } },
        },
      }),
      app.prisma.figure.count({ where: { sculptors: { some: { sculptorId: sculptor.id } }, isDeleted: false } }),
    ]);

    return { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
  });

  app.post("/", async (req: any, reply: any) => {
    const data = createSculptorSchema.parse(req.body);
    const existing = await app.prisma.sculptor.findUnique({ where: { slug: data.slug } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });

    const sculptor = await app.prisma.sculptor.create({ data });
    await invalidateSculptorCache(app);
    return reply.status(201).send({ success: true, data: sculptor });
  });

  app.put("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const data = updateSculptorSchema.parse(req.body);
    const existing = await app.prisma.sculptor.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "SCULPTOR_NOT_FOUND" } });

    if (data.slug && data.slug !== slug) {
      const slugExists = await app.prisma.sculptor.findUnique({ where: { slug: data.slug } });
      if (slugExists) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    }

    const sculptor = await app.prisma.sculptor.update({ where: { slug }, data });
    await invalidateSculptorCache(app, slug);
    if (data.slug && data.slug !== slug) await invalidateSculptorCache(app, data.slug);
    return { success: true, data: sculptor };
  });

  app.delete("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const existing = await app.prisma.sculptor.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "SCULPTOR_NOT_FOUND" } });

    const figureCount = await app.prisma.figureSculptor.count({ where: { sculptorId: existing.id } });
    if (figureCount > 0) return reply.status(409).send({ success: false, error: { code: "HAS_FIGURES", message: `Sculptor has ${figureCount} figures, reassign them first` } });

    await app.prisma.sculptor.delete({ where: { slug } });
    await invalidateSculptorCache(app, slug);
    return { success: true, data: { deleted: true } };
  });
}
