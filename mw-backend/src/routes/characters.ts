import { FastifyInstance } from "fastify";
import { z } from "zod";
import { scanKeys } from "../security/redisGuard.js";
import { requireAdminRole } from "../plugins/adminGuard.js";

const listQuery = z.object({
  page: z.coerce.number().min(1).default(1),
  perPage: z.coerce.number().min(1).max(100).default(50),
});

const createCharacterSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  nameJp: z.string().optional(),
  nameEn: z.string().optional(),
  seriesId: z.coerce.bigint().optional(),
  description: z.string().optional(),
});

const updateCharacterSchema = createCharacterSchema.partial();

async function invalidateCharacterCache(app: FastifyInstance, slug?: string) {
  const keys: string[] = [];
  const listKeys = await scanKeys(app.redis, "characters:list:*");
  keys.push(...listKeys);
  if (slug) {
    const detailKey = `characters:detail:${slug}`;
    keys.push(detailKey);
  }
  if (keys.length > 0) await app.redis.unlink(...keys);
}

export async function characterRoutes(app: FastifyInstance) {
  app.get("/", async (req: any) => {
    const query = listQuery.parse(req.query);
    const cacheKey = `characters:list:${query.page}:${query.perPage}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const [data, total] = await Promise.all([
      app.prisma.character.findMany({
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { name: "asc" },
        include: { _count: { select: { figures: true } }, series: { select: { id: true, slug: true, name: true, nameEn: true } } },
      }),
      app.prisma.character.count(),
    ]);

    const result = { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 600);
    return result;
  });

  app.get("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const cacheKey = `characters:detail:${slug}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const character = await app.prisma.character.findUnique({
      where: { slug },
      include: { _count: { select: { figures: true } }, series: { select: { id: true, slug: true, name: true, nameEn: true } } },
    });
    if (!character) return reply.status(404).send({ success: false, error: { code: "CHARACTER_NOT_FOUND" } });

    const result = { success: true, data: character };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
    return result;
  });

  app.get("/:slug/figures", async (req: any) => {
    const { slug } = req.params as { slug: string };
    const query = listQuery.parse(req.query);
    const character = await app.prisma.character.findUnique({ where: { slug }, select: { id: true } });
    if (!character) return { success: true, data: [], meta: { page: 1, perPage: 24, total: 0, totalPages: 0 } };

    const [data, total] = await Promise.all([
      app.prisma.figure.findMany({
        where: { characters: { some: { characterId: character.id } }, isDeleted: false },
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
      app.prisma.figure.count({ where: { characters: { some: { characterId: character.id } }, isDeleted: false } }),
    ]);

    return { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
  });

  app.post("/", { preHandler: requireAdminRole("admin") }, async (req: any, reply: any) => {
    const data = createCharacterSchema.parse(req.body);
    const existing = await app.prisma.character.findUnique({ where: { slug: data.slug } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });

    const character = await app.prisma.character.create({ data });
    await invalidateCharacterCache(app);
    return reply.status(201).send({ success: true, data: character });
  });

  app.put("/:slug", { preHandler: requireAdminRole("admin") }, async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const data = updateCharacterSchema.parse(req.body);
    const existing = await app.prisma.character.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "CHARACTER_NOT_FOUND" } });

    if (data.slug && data.slug !== slug) {
      const slugExists = await app.prisma.character.findUnique({ where: { slug: data.slug } });
      if (slugExists) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    }

    const character = await app.prisma.character.update({ where: { slug }, data });
    await invalidateCharacterCache(app, slug);
    if (data.slug && data.slug !== slug) await invalidateCharacterCache(app, data.slug);
    return { success: true, data: character };
  });

  app.delete("/:slug", { preHandler: requireAdminRole("admin") }, async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const existing = await app.prisma.character.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "CHARACTER_NOT_FOUND" } });

    const figureCount = await app.prisma.figureCharacter.count({ where: { characterId: existing.id } });
    if (figureCount > 0) return reply.status(409).send({ success: false, error: { code: "HAS_FIGURES", message: `Character has ${figureCount} figures, reassign them first` } });

    await app.prisma.character.delete({ where: { slug } });
    await invalidateCharacterCache(app, slug);
    return { success: true, data: { deleted: true } };
  });
}
