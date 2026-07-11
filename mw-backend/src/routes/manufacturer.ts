import { FastifyInstance } from "fastify";
import { z } from "zod";
import { scanKeys } from "../shared/cache/scan-keys.js";

const listQuery = z.object({
  page: z.coerce.number().min(1).default(1),
  perPage: z.coerce.number().min(1).max(100).default(50),
});

const createManufacturerSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  nameJp: z.string().optional(),
  nameEn: z.string().optional(),
  country: z.string().optional(),
  website: z.string().optional(),
  description: z.string().optional(),
});

const updateManufacturerSchema = createManufacturerSchema.partial();

async function invalidateManufacturerCache(app: FastifyInstance, slug?: string) {
  if (slug) {
    await app.redis.del(`manufacturers:detail:${slug}`);
  }
  await scanKeys(app.redis, "manufacturers:list:*");
}

export async function manufacturerRoutes(app: FastifyInstance) {
  app.get("/", async (req: any) => {
    const query = listQuery.parse(req.query);
    const cacheKey = `manufacturers:list:${query.page}:${query.perPage}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const [data, total] = await Promise.all([
      app.prisma.manufacturer.findMany({
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { name: "asc" },
        include: { _count: { select: { figures: true } } },
      }),
      app.prisma.manufacturer.count(),
    ]);

    const result = { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 600);
    return result;
  });

  app.get("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const cacheKey = `manufacturers:detail:${slug}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const manufacturer = await app.prisma.manufacturer.findUnique({
      where: { slug },
      include: { _count: { select: { figures: true } } },
    });
    if (!manufacturer) return reply.status(404).send({ success: false, error: { code: "MANUFACTURER_NOT_FOUND" } });

    const result = { success: true, data: manufacturer };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
    return result;
  });

  app.get("/:slug/figures", async (req: any) => {
    const { slug } = req.params as { slug: string };
    const query = listQuery.parse(req.query);
    const manufacturer = await app.prisma.manufacturer.findUnique({ where: { slug }, select: { id: true } });
    if (!manufacturer) return { success: true, data: [], meta: { page: 1, perPage: 24, total: 0, totalPages: 0 } };

    const [data, total] = await Promise.all([
      app.prisma.figure.findMany({
        where: { manufacturerId: manufacturer.id, isDeleted: false },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { releaseDate: "desc" },
        include: {
          series: { select: { id: true, slug: true, name: true, nameEn: true } },
          images: { orderBy: { sortOrder: "asc" }, take: 1, select: { id: true, alt: true, size: true, format: true } },
          categories: { include: { category: { select: { slug: true, name: true } } } },
        },
      }),
      app.prisma.figure.count({ where: { manufacturerId: manufacturer.id, isDeleted: false } }),
    ]);

    return { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
  });

  app.post("/", async (req: any, reply: any) => {
    const data = createManufacturerSchema.parse(req.body);
    const existing = await app.prisma.manufacturer.findUnique({ where: { slug: data.slug } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });

    const manufacturer = await app.prisma.manufacturer.create({ data });
    await invalidateManufacturerCache(app);
    return reply.status(201).send({ success: true, data: manufacturer });
  });

  app.put("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const data = updateManufacturerSchema.parse(req.body);
    const existing = await app.prisma.manufacturer.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "MANUFACTURER_NOT_FOUND" } });

    if (data.slug && data.slug !== slug) {
      const slugExists = await app.prisma.manufacturer.findUnique({ where: { slug: data.slug } });
      if (slugExists) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    }

    const manufacturer = await app.prisma.manufacturer.update({ where: { slug }, data });
    await invalidateManufacturerCache(app, slug);
    if (data.slug && data.slug !== slug) await invalidateManufacturerCache(app, data.slug);
    return { success: true, data: manufacturer };
  });

  app.delete("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const existing = await app.prisma.manufacturer.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "MANUFACTURER_NOT_FOUND" } });

    const figureCount = await app.prisma.figure.count({ where: { manufacturerId: existing.id } });
    if (figureCount > 0) return reply.status(409).send({ success: false, error: { code: "HAS_FIGURES", message: `Manufacturer has ${figureCount} figures, reassign them first` } });

    await app.prisma.manufacturer.delete({ where: { slug } });
    await invalidateManufacturerCache(app, slug);
    return { success: true, data: { deleted: true } };
  });
}
