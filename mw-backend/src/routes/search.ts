import { FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * 搜索 API 路由
 * =============
 *
 * 提供全文搜索功能，支持按类型筛选。
 *
 * 端点: GET /api/v1/search?q={query}&type={type}
 *
 * 参数:
 *   q    — 搜索关键词 (1-200 字符)
 *   type — 结果类型: all | figure | series | manufacturer | sculptor | character (默认 all)
 *   lang/locale — localized language, defaults to fr
 *   page/perPage — 分页 (每个结果类型独立分页)
 *
 * 返回格式:
 *   {
 *     success: true,
 *     data: {
 *       figures:       { items: [...], total: number },
 *       series:        { items: [...], total: number },
 *       manufacturers: { items: [...], total: number },
 *       sculptors:     { items: [...], total: number },
 *       characters:    { items: [...], total: number },
 *     },
 *     meta: { totalResults, figuresCount, seriesCount, ... }
 *   }
 *
 * 注意:
 *   - 搜索结果中的关联实体（如 figure 的 manufacturer）也包含 nameEn 字段，
 *     以保持与列表 API 返回格式一致。
 *
 * @package ModelWiki API
 * @since   1.0.0
 */

const searchQuery = z.object({
  q: z.string().min(1).max(200),
  type: z.enum(["all", "figure", "series", "manufacturer", "sculptor", "character"]).default("all"),
  lang: z.string().optional(),
  locale: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  perPage: z.coerce.number().min(1).max(100).default(12),
});

/** 每个结果类型最大返回数量，防止单次搜索压力过大 */
const SEARCH_LIMIT = 30;

function publicSlug(slug?: string | null): string {
  return String(slug || "")
    .replace(/-+$/g, "");
}

function normalizeLang(value?: string | null): string {
  const lang = String(value || "fr").trim().toLowerCase().split(/[-_]/)[0];
  return lang || "fr";
}

function firstText(...values: any[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function publicEntityName(entity: any): string | null {
  return firstText(entity?.nameEn, entity?.name, entity?.nameJp);
}

export async function searchRoutes(app: FastifyInstance) {
  app.get("/", async (req: any, reply: any) => {
    const query = searchQuery.parse(req.query);
    const searchTerm = query.q;
    const resultType = query.type;
    const lang = normalizeLang(query.lang || query.locale);

    // 构建模糊搜索条件
    const textFilter = { contains: searchTerm, mode: "insensitive" as const };
    const whereCondition = {
      OR: [
        { name: textFilter },
        { nameJp: textFilter },
        { nameEn: textFilter },
      ],
    };

    // 通用 Prisma select — 包含 nameEn 以保持与列表 API 一致
    const figureSelect = {
      id: true, slug: true, name: true, nameJp: true, nameEn: true,
      description: true, priceJpy: true, releaseDate: true, scale: true,
      manufacturer: { select: { id: true, slug: true, name: true, nameEn: true } },
      series: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true } },
      characters: { include: { character: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true } } } },
      localized: {
        where: { language: lang },
        orderBy: { id: "asc" as const },
      },
      images: {
        orderBy: { sortOrder: "asc" as const },
        take: 3,
        select: {
          id: true, url: true, alt: true, size: true, format: true,
          width: true, height: true, sortOrder: true, source: true, data: true,
        },
      },
      categories: { include: { category: { select: { slug: true, name: true } } } },
    };

    const characterSelect = {
      id: true,
      slug: true,
      name: true,
      nameJp: true,
      nameEn: true,
      series: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true } },
      _count: { select: { figures: true } },
    };

    /**
     * Transform figure images to expose a usable `url` field.
     * The list API builds `/api/v1/figures/images/:id` URLs via groupImageVariants,
     * but search returned raw DB rows where `url` is a legacy external URL (often null).
     * This normalizes search results so the frontend figure-card works the same way.
     */
    function isSafeDisplayImage(image: any): boolean {
      if (!image) return false;
      const w = Number(image.width) || 0;
      const h = Number(image.height) || 0;
      const source = String(image.source || image.url || "");
      const metaData: any = (image as any).data || {};
      const sourceKind = String(metaData.source_kind || "");
      const safeDisplay = metaData.safe_display === true;
      if (source.includes("myfigurecollection.net/upload/pictures/")) {
        return sourceKind === "official_item_image" && safeDisplay;
      }
      if (source.includes("/upload/items/")) {
        return sourceKind === "official_item_thumbnail" && safeDisplay;
      }
      if (w === 0 || h === 0) return true;
      const ratio = Math.max(w, h) / Math.min(w, h);
      if (ratio > 3.5) return false;
      if (w < 300 && h < 300) return false;
      return true;
    }

    function normalizeFigureImages(figures: any[]): any[] {
      return figures.map((fig: any) => {
        const localized = Array.isArray(fig.localized) ? fig.localized[0] : null;
        const featuredCharacter = Array.isArray(fig.characters)
          ? fig.characters.find((item: any) => item?.isFeatured)?.character || fig.characters[0]?.character
          : null;
        const displayTitle = firstText(localized?.title, fig.nameEn, fig.name, fig.nameJp, fig.slug) || "";
        const originalTitle = firstText(fig.nameJp, fig.name, fig.nameEn, displayTitle) || displayTitle;
        const displayOrigin = firstText(localized?.origin, publicEntityName(fig.series));
        const displayCharacter = firstText(localized?.character, publicEntityName(featuredCharacter));
        const displayDescription = firstText(localized?.description, fig.description);

        return {
          ...fig,
          slug: publicSlug(fig.slug),
          displayTitle,
          originalTitle,
          displayOrigin,
          displayCharacter,
          displayDescription,
          images: (fig.images || [])
            .filter((img: any) => isSafeDisplayImage(img))
            .map((img: any) => ({
              ...img,
              url: `/api/v1/figures/images/${img.id}`,
            })),
        };
      });
    }

    const whereDeleted = { isDeleted: false };

    let result;
    if (resultType === "figure") {
      const [items, total] = await Promise.all([
        app.prisma.figure.findMany({
          where: { ...whereCondition, ...whereDeleted },
          select: figureSelect,
          take: SEARCH_LIMIT,
          orderBy: { releaseDate: "desc" },
        }),
        app.prisma.figure.count({ where: { ...whereCondition, ...whereDeleted } }),
      ]);
      result = {
        figures: { items: normalizeFigureImages(items as any[]), total },
        series: { items: [], total: 0 },
        manufacturers: { items: [], total: 0 },
        sculptors: { items: [], total: 0 },
        characters: { items: [], total: 0 },
        meta: { totalResults: total, figuresCount: total, seriesCount: 0, manufacturersCount: 0, sculptorsCount: 0, charactersCount: 0 },
      };
    } else if (resultType === "series") {
      const [items, total] = await Promise.all([
        app.prisma.series.findMany({
          where: whereCondition,
          select: { id: true, slug: true, name: true, nameJp: true, nameEn: true, _count: { select: { figures: true } } },
          take: SEARCH_LIMIT,
        }),
        app.prisma.series.count({ where: whereCondition }),
      ]);
      result = {
        figures: { items: [], total: 0 },
        series: { items, total },
        manufacturers: { items: [], total: 0 },
        sculptors: { items: [], total: 0 },
        characters: { items: [], total: 0 },
        meta: { totalResults: total, figuresCount: 0, seriesCount: total, manufacturersCount: 0, sculptorsCount: 0, charactersCount: 0 },
      };
    } else if (resultType === "manufacturer") {
      const [items, total] = await Promise.all([
        app.prisma.manufacturer.findMany({
          where: whereCondition,
          select: { id: true, slug: true, name: true, nameJp: true, nameEn: true, country: true, _count: { select: { figures: true } } },
          take: SEARCH_LIMIT,
        }),
        app.prisma.manufacturer.count({ where: whereCondition }),
      ]);
      result = {
        figures: { items: [], total: 0 },
        series: { items: [], total: 0 },
        manufacturers: { items, total },
        sculptors: { items: [], total: 0 },
        characters: { items: [], total: 0 },
        meta: { totalResults: total, figuresCount: 0, seriesCount: 0, manufacturersCount: total, sculptorsCount: 0, charactersCount: 0 },
      };
    } else if (resultType === "sculptor") {
      const [items, total] = await Promise.all([
        app.prisma.sculptor.findMany({
          where: whereCondition,
          select: { id: true, slug: true, name: true, nameJp: true, nameEn: true, _count: { select: { figures: true } } },
          take: SEARCH_LIMIT,
        }),
        app.prisma.sculptor.count({ where: whereCondition }),
      ]);
      result = {
        figures: { items: [], total: 0 },
        series: { items: [], total: 0 },
        manufacturers: { items: [], total: 0 },
        sculptors: { items, total },
        characters: { items: [], total: 0 },
        meta: { totalResults: total, figuresCount: 0, seriesCount: 0, manufacturersCount: 0, sculptorsCount: total, charactersCount: 0 },
      };
    } else if (resultType === "character") {
      const [items, total] = await Promise.all([
        app.prisma.character.findMany({
          where: whereCondition,
          select: characterSelect,
          take: SEARCH_LIMIT,
        }),
        app.prisma.character.count({ where: whereCondition }),
      ]);
      result = {
        figures: { items: [], total: 0 },
        series: { items: [], total: 0 },
        manufacturers: { items: [], total: 0 },
        sculptors: { items: [], total: 0 },
        characters: { items, total },
        meta: { totalResults: total, figuresCount: 0, seriesCount: 0, manufacturersCount: 0, sculptorsCount: 0, charactersCount: total },
      };
    } else {
      // "all" — 并行搜索所有 public entity types.
      const [figItems, figCount, serItems, serCount, mfrItems, mfrCount, scItems, scCount, charItems, charCount] = await Promise.all([
        app.prisma.figure.findMany({ where: { ...whereCondition, ...whereDeleted }, select: figureSelect, take: SEARCH_LIMIT, orderBy: { releaseDate: "desc" } }),
        app.prisma.figure.count({ where: { ...whereCondition, ...whereDeleted } }),
        app.prisma.series.findMany({ where: whereCondition, select: { id: true, slug: true, name: true, nameJp: true, nameEn: true, _count: { select: { figures: true } } }, take: SEARCH_LIMIT }),
        app.prisma.series.count({ where: whereCondition }),
        app.prisma.manufacturer.findMany({ where: whereCondition, select: { id: true, slug: true, name: true, nameJp: true, nameEn: true, country: true, _count: { select: { figures: true } } }, take: SEARCH_LIMIT }),
        app.prisma.manufacturer.count({ where: whereCondition }),
        app.prisma.sculptor.findMany({ where: whereCondition, select: { id: true, slug: true, name: true, nameJp: true, nameEn: true, _count: { select: { figures: true } } }, take: SEARCH_LIMIT }),
        app.prisma.sculptor.count({ where: whereCondition }),
        app.prisma.character.findMany({ where: whereCondition, select: characterSelect, take: SEARCH_LIMIT }),
        app.prisma.character.count({ where: whereCondition }),
      ]);

      result = {
        figures:       { items: normalizeFigureImages(figItems as any[]), total: figCount as number },
        series:        { items: serItems as any[], total: serCount as number },
        manufacturers: { items: mfrItems as any[], total: mfrCount as number },
        sculptors:     { items: scItems as any[], total: scCount as number },
        characters:    { items: charItems as any[], total: charCount as number },
        meta: {
          totalResults: (figCount + serCount + mfrCount + scCount + charCount) as number,
          figuresCount: figCount as number,
          seriesCount: serCount as number,
          manufacturersCount: mfrCount as number,
          sculptorsCount: scCount as number,
          charactersCount: charCount as number,
        },
      };
    }

    // 分离 meta 到顶层响应，其余放在 data 中
    const { meta, ...data } = result;
    return { success: true, data, meta };
  });
}
