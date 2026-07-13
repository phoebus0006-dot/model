import { FastifyInstance } from "fastify";
import { z } from "zod";
import { scanKeys } from "../security/redisGuard.js";

const createCategorySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  parentId: z.coerce.bigint().optional(),
  sortOrder: z.number().int().optional(),
});

const updateCategorySchema = createCategorySchema.partial();

async function invalidateCategoryCache(app: FastifyInstance, slug?: string) {
  const keys: string[] = [];
  const listKeys = await scanKeys(app.redis, "categories:*");
  keys.push(...listKeys);
  if (slug) {
    const detailKey = `categories:detail:${slug}`;
    keys.push(detailKey);
  }
  if (keys.length > 0) await app.redis.unlink(...keys);
}

async function activeFigureCountByCategory(app: FastifyInstance, categoryIds: any[]) {
  if (!categoryIds.length) return new Map<string, number>();

  const rows = await app.prisma.figureCategory.groupBy({
    by: ["categoryId"],
    where: {
      categoryId: { in: categoryIds },
      figure: { isDeleted: false },
    },
    _count: { figureId: true },
  });

  return new Map(rows.map((row: any) => [String(row.categoryId), row._count.figureId || 0]));
}

function attachActiveCounts(category: any, counts: Map<string, number>): any {
  return {
    ...category,
    _count: {
      ...(category._count || {}),
      figures: counts.get(String(category.id)) || 0,
    },
    children: (category.children || []).map((child: any) => attachActiveCounts(child, counts)),
  };
}

function collectCategoryIds(categories: any[]): any[] {
  const ids: any[] = [];
  const visit = (category: any) => {
    ids.push(category.id);
    (category.children || []).forEach(visit);
  };
  categories.forEach(visit);
  return ids;
}

export async function categoryRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const cacheKey = "categories:all";
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const categories = await app.prisma.category.findMany({
      where: { parentId: null },
      include: { children: { include: { children: true } } },
      orderBy: { sortOrder: "asc" },
    });
    const counts = await activeFigureCountByCategory(app, collectCategoryIds(categories));
    const categoriesWithCounts = categories.map((category: any) => attachActiveCounts(category, counts));

    const result = { success: true, data: JSON.parse(JSON.stringify(categoriesWithCounts)) };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 600);
    return result;
  });

  app.get("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const category = await app.prisma.category.findUnique({
      where: { slug },
      include: { parent: true, children: true },
    });
    if (!category) return reply.status(404).send({ success: false, error: { code: "CATEGORY_NOT_FOUND" } });
    const counts = await activeFigureCountByCategory(app, collectCategoryIds([category]));
    return { success: true, data: JSON.parse(JSON.stringify(attachActiveCounts(category, counts))) };
  });

  app.post("/", async (req: any, reply: any) => {
    const data = createCategorySchema.parse(req.body);
    const existing = await app.prisma.category.findUnique({ where: { slug: data.slug } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });

    const category = await app.prisma.category.create({ data });
    await invalidateCategoryCache(app);
    return reply.status(201).send({ success: true, data: JSON.parse(JSON.stringify(category)) });
  });

  app.put("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const data = updateCategorySchema.parse(req.body);
    const existing = await app.prisma.category.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "CATEGORY_NOT_FOUND" } });

    if (data.slug && data.slug !== slug) {
      const slugExists = await app.prisma.category.findUnique({ where: { slug: data.slug } });
      if (slugExists) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    }

    const category = await app.prisma.category.update({ where: { slug }, data });
    await invalidateCategoryCache(app, slug);
    if (data.slug && data.slug !== slug) await invalidateCategoryCache(app, data.slug);
    return { success: true, data: JSON.parse(JSON.stringify(category)) };
  });

  app.delete("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const existing = await app.prisma.category.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "CATEGORY_NOT_FOUND" } });

    const childCount = await app.prisma.category.count({ where: { parentId: existing.id } });
    if (childCount > 0) return reply.status(409).send({ success: false, error: { code: "HAS_CHILDREN", message: `Category has ${childCount} child categories, reassign them first` } });

    const figureCount = await app.prisma.figureCategory.count({ where: { categoryId: existing.id } });
    if (figureCount > 0) return reply.status(409).send({ success: false, error: { code: "HAS_FIGURES", message: `Category has ${figureCount} figures, reassign them first` } });

    await app.prisma.category.delete({ where: { slug } });
    await invalidateCategoryCache(app, slug);
    return { success: true, data: { deleted: true } };
  });
}
