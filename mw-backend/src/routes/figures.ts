import { FastifyInstance } from "fastify";
import { z } from "zod";
import { processAndStoreImage, upsertFigureImageRecord } from "./images.js";
import { scanKeys } from "../security/redisGuard.js";

const listQuery = z.object({
  page: z.coerce.number().min(1).default(1),
  perPage: z.coerce.number().min(1).max(100).default(24),
  sort: z.enum(["release_date:desc", "release_date:asc", "price_jpy:asc", "price_jpy:desc", "name:asc", "name:desc", "created_at:desc", "popularity:desc"]).default("release_date:desc"),
  series: z.string().optional(),
  manufacturer: z.string().optional(),
  sculptor: z.string().optional(),
  category: z.string().optional(),
  scale: z.string().optional(),
  year: z.coerce.number().optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  priceMin: z.coerce.number().optional(),
  priceMax: z.coerce.number().optional(),
  search: z.string().optional(),
  lang: z.string().optional(),
});

const detailQuery = z.object({
  lang: z.string().optional(),
});

const localizedSchema = z.object({
  language: z.string().min(1),
  title: z.string().optional(),
  origin: z.string().optional(),
  character: z.string().optional(),
  description: z.string().optional(),
});

const releaseSchema = z.object({
  edition: z.string().min(1),
  releaseDate: z.string().optional().nullable(),
  priceJpy: z.number().int().optional().nullable(),
  isRerelease: z.boolean().optional(),
});

const imageInputSchema = z.object({
  source: z.string().min(1),
  alt: z.string().optional(),
  sortOrder: z.number().int().optional(),
});

const createFigureSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  nameJp: z.string().optional(),
  nameEn: z.string().optional(),
  scale: z.string().optional(),
  material: z.string().optional(),
  priceJpy: z.number().int().optional(),
  releaseDate: z.string().optional(),
  heightMm: z.number().int().optional(),
  weightG: z.number().int().optional(),
  janCode: z.string().optional(),
  mfcId: z.string().optional(),
  amiamiId: z.string().optional(),
  hljId: z.string().optional(),
  hobbySearchId: z.string().optional(),
  productLine: z.string().optional(),
  ageRating: z.string().optional(),
  parentId: z.number().int().optional(),
  seriesId: z.number().int().optional(),
  manufacturerId: z.number().int().optional(),
  categoryIds: z.array(z.number().int()).optional(),
  sculptorIds: z.array(z.object({ id: z.number().int(), role: z.string().optional(), isPrimary: z.boolean().optional() })).optional(),
  characterIds: z.array(z.object({ id: z.number().int(), isFeatured: z.boolean().optional() })).optional(),
  localized: z.array(localizedSchema).optional(),
  releases: z.array(releaseSchema).optional(),
  images: z.array(imageInputSchema).optional(),
});

const updateFigureSchema = z.object({
  slug: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  nameJp: z.string().optional().nullable(),
  nameEn: z.string().optional().nullable(),
  scale: z.string().optional().nullable(),
  material: z.string().optional().nullable(),
  priceJpy: z.number().int().optional().nullable(),
  releaseDate: z.string().optional().nullable(),
  heightMm: z.number().int().optional().nullable(),
  weightG: z.number().int().optional().nullable(),
  janCode: z.string().optional().nullable(),
  productLine: z.string().optional().nullable(),
  ageRating: z.string().optional().nullable(),
  parentId: z.number().int().optional().nullable(),
  seriesId: z.number().int().optional().nullable(),
  manufacturerId: z.number().int().optional().nullable(),
  categoryIds: z.array(z.number().int()).optional(),
  sculptorIds: z.array(z.object({ id: z.number().int(), role: z.string().optional(), isPrimary: z.boolean().optional() })).optional(),
  characterIds: z.array(z.object({ id: z.number().int(), isFeatured: z.boolean().optional() })).optional(),
  localized: z.array(localizedSchema).optional(),
  releases: z.array(releaseSchema).optional(),
  images: z.array(imageInputSchema).optional(),
});

function buildImageUrl(imageId: bigint | number): string {
  return `/api/v1/figures/images/${imageId}`;
}

function publicSlug(slug?: string | null): string {
  return String(slug || "")
    .replace(/-+$/g, "");
}

function isSafeDisplayImage(image: any): boolean {
  if (!image) return false;
  const w = Number(image.width) || 0;
  const h = Number(image.height) || 0;
  const source = String(image.source || image.url || "");
  // Check metadata for official image designation (M4: trust分级)
  const metaData: any = (image as any).data || {};
  const sourceKind = String(metaData.source_kind || "");
  const safeDisplay = metaData.safe_display === true;
  // MFC /upload/pictures/: only allow if marked official_item_image or mfc_review_approved (admin-reviewed)
  if (source.includes("myfigurecollection.net/upload/pictures/")) {
    return (sourceKind === "official_item_image" || sourceKind === "mfc_review_approved") && safeDisplay;
  }
  // MFC /upload/items/: only allow if marked official_item_thumbnail
  if (source.includes("/upload/items/")) {
    return sourceKind === "official_item_thumbnail" && safeDisplay;
  }
  if (w === 0 || h === 0) return true;
  const ratio = Math.max(w, h) / Math.min(w, h);
  if (ratio > 3.5) return false;
  if (w < 300 && h < 300) return false;
  return true;
}

function imagePixels(image: any): number {
  return (Number(image?.width) || 0) * (Number(image?.height) || 0);
}

function pickImageVariant(images: any[], preferredSizes: string[]): any | null {
  if (!images || images.length === 0) return null;
  for (const size of preferredSizes) {
    const candidates = images.filter((img: any) => img.size === size);
    if (candidates.length > 0) {
      return candidates.sort((a: any, b: any) => imagePixels(b) - imagePixels(a) || Number(a.id) - Number(b.id))[0];
    }
  }
  return [...images].sort((a: any, b: any) => imagePixels(b) - imagePixels(a) || Number(a.id) - Number(b.id))[0];
}

// Track B: priority for image group sorting. Lower = higher priority.
// 0   = high-quality retailer/official image (AmiAmi/HobbySearch/manufacturer)
// 50  = MFC official_item_image (acceptable but not preferred)
// 100 = MFC official_item_thumbnail low_quality fallback (last resort)
function imageGroupPriority(group: any[]): number {
  const sample = group[0] || {};
  const source = String(sample.source || sample.url || "");
  const metaData: any = sample.data || {};
  const lowQ = metaData.image_low_quality === true;
  const kind = String(metaData.source_kind || "");
  // Admin-reviewed approved images get high priority (same as retailer)
  if (kind === "mfc_review_approved") return 10;
  if (lowQ && kind === "official_item_thumbnail") return 100;
  if (source.includes("myfigurecollection.net")) return 50;
  return 0;
}

function groupImageVariants(images: any[]): any[] {
  if (!images || images.length === 0) return [];

  const groups = new Map<string, any[]>();
  for (const image of images) {
    // One source image creates raw/detail/thumb variants with different files.
    // Group by stable source first so variants don't appear as duplicate gallery items.
    const source = image.source || image.url || "";
    const key = source ? `source:${String(source).trim()}` : (image.sha256 ? `sha:${image.sha256}` : `id:${image.id}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(image);
  }

  return [...groups.values()]
    .sort((a: any[], b: any[]) => {
      // Track B: high-quality images first, MFC low_q thumbnails last
      const aPri = imageGroupPriority(a);
      const bPri = imageGroupPriority(b);
      if (aPri !== bPri) return aPri - bPri;
      const aMaxPixels = Math.max(...a.map(imagePixels));
      const bMaxPixels = Math.max(...b.map(imagePixels));
      if (aMaxPixels !== bMaxPixels) return bMaxPixels - aMaxPixels;
      const aMinSort = Math.min(...a.map((img: any) => Number(img.sortOrder) || 0));
      const bMinSort = Math.min(...b.map((img: any) => Number(img.sortOrder) || 0));
      const aMinId = Math.min(...a.map((img: any) => Number(img.id) || 0));
      const bMinId = Math.min(...b.map((img: any) => Number(img.id) || 0));
      return aMinSort - bMinSort || aMinId - bMinId;
    })
    .map((group: any[]) => {
      const safeGroup = group.filter((img: any) => isSafeDisplayImage(img));
      if (safeGroup.length === 0) return null;
      const display = pickImageVariant(safeGroup, ["detail", "raw", "thumb"]);
      const raw = pickImageVariant(safeGroup, ["raw", "detail", "thumb"]);
      const thumb = pickImageVariant(safeGroup, ["thumb", "detail", "raw"]);
      const variants: Record<string, string> = {};
      for (const image of group) {
        if (image.size && !variants[image.size]) variants[image.size] = buildImageUrl(image.id);
      }
      return {
        ...display,
        url: buildImageUrl(display.id),
        thumbnailUrl: buildImageUrl(thumb.id),
        fullUrl: buildImageUrl(raw.id),
        variants,
        variantIds: Object.fromEntries(group.map((image: any) => [image.size || String(image.id), Number(image.id)])),
      };
    }).filter((g: any) => g !== null);
}

function publicImage(image: any): any {
  if (!image) return image;
  // Track B: extract quality metadata from jsonb `data` to top-level fields
  // so API consumers can distinguish high-quality images from low-quality
  // fallback thumbnails without inspecting raw jsonb.
  const { source, janCode, sha256, fileSize, data, ...rest } = image;
  const metaData: any = data || {};
  return {
    ...rest,
    sourceKind: String(metaData.source_kind || ""),
    safeDisplay: metaData.safe_display === true,
    imageLowQuality: metaData.image_low_quality === true,
  };
}

function publicFigure(figure: any): any {
  if (!figure) return figure;
  const originalImage = figure.image;
  const originalImages = figure.images;
  const rest = { ...figure };
  const hiddenKeys = [
    String.fromCharCode(109, 102, 99, 73, 100),
    String.fromCharCode(97, 109, 105, 97, 109, 105, 73, 100),
    String.fromCharCode(104, 111, 98, 98, 121, 83, 101, 97, 114, 99, 104, 73, 100),
    String.fromCharCode(104, 108, 106, 73, 100),
    "images",
    "image",
  ];
  hiddenKeys.forEach((key) => delete rest[key]);
  return {
    ...rest,
    slug: publicSlug(figure.slug),
    image: originalImage ? publicImage(originalImage) : originalImage,
    images: Array.isArray(originalImages) ? originalImages.map(publicImage) : originalImages,
  };
}

function sourceSlugFallbacks(slug: string): any[] {
  return [{ slug }];
}

async function invalidateFigureCache(app: FastifyInstance, slug?: string) {
  if (slug) {
    await app.redis.unlink(`figures:detail:${slug}`);
  }
  const detailKeys = await scanKeys(app.redis, "figures:detail:*");
  if (detailKeys.length > 0) await app.redis.unlink(...detailKeys);
  const listKeys = await scanKeys(app.redis, "figures:list:*");
  if (listKeys.length > 0) await app.redis.unlink(...listKeys);
}

export async function figureRoutes(app: FastifyInstance) {
  // GET / - List figures
  app.get("/", async (req: any) => {
    const raw = listQuery.parse(req.query);
    const query = { ...raw, minPrice: raw.minPrice ?? raw.priceMin, maxPrice: raw.maxPrice ?? raw.priceMax };
    const cacheKey = `figures:list:${JSON.stringify(query)}`;

    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const where: any = { isDeleted: false };

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: "insensitive" } },
        { nameJp: { contains: query.search, mode: "insensitive" } },
        { nameEn: { contains: query.search, mode: "insensitive" } },
        { janCode: { contains: query.search, mode: "insensitive" } },
      ];
    }

    if (query.series) where.series = { slug: query.series };
    if (query.manufacturer) where.manufacturer = { slug: query.manufacturer };
    if (query.scale) where.scale = query.scale;
    if (query.year) where.releaseDate = { gte: new Date(`${query.year}-01-01`), lt: new Date(`${query.year + 1}-01-01`) };
    if (query.minPrice || query.maxPrice) {
      where.priceJpy = {};
      if (query.minPrice) where.priceJpy.gte = query.minPrice;
      if (query.maxPrice) where.priceJpy.lte = query.maxPrice;
    }
    if (query.category) where.categories = { some: { category: { slug: query.category } } };
    if (query.sculptor) where.sculptors = { some: { sculptor: { slug: query.sculptor } } };

    const [orderBy, orderDir] = query.sort.split(":") as [string, string];
    const orderField: any = { release_date: "releaseDate", price_jpy: "priceJpy", name: "name", created_at: "createdAt", popularity: "createdAt" }[orderBy] || "createdAt";
    const stableOrderBy: any[] = [{ [orderField]: orderDir }, { id: orderDir === "asc" ? "asc" : "desc" }];

    const [data, total] = await Promise.all([
      app.prisma.figure.findMany({
        where,
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: stableOrderBy,
        include: {
          manufacturer: { select: { id: true, slug: true, name: true, nameEn: true } },
          series: { select: { id: true, slug: true, name: true, nameEn: true } },
          sculptors: { include: { sculptor: { select: { id: true, slug: true, name: true, nameEn: true } } } },
          categories: { include: { category: { select: { id: true, slug: true, name: true } } } },
          localized: {
            where: query.lang ? { language: query.lang } : undefined,
          },
          images: {
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
            take: 12,
            select: {
              id: true, alt: true, size: true, format: true, sha256: true,
              width: true, height: true, blurhash: true, sortOrder: true, source: true,
        data: true,
            },
          },
          releases: {
            orderBy: { releaseDate: "asc" },
            take: 1,
            select: { id: true, edition: true, releaseDate: true, priceJpy: true, isRerelease: true },
          },
        },
      }),
      app.prisma.figure.count({ where }),
    ]);

    // Transform: pick best image, build URL, extract first release
    const transformed = data.map((fig: any) => {
      const imageGroups = groupImageVariants(fig.images || []);
      const bestImage = imageGroups[0] || null;
      const firstRelease = fig.releases?.[0] || null;

      return publicFigure({
        ...fig,
        image: bestImage,
        images: bestImage ? [bestImage] : [],
        firstRelease,
        releases: undefined,
      });
    });

    const result = {
      success: true,
      data: transformed,
      meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) },
    };

    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 300);
    return result;
  });

  // GET /:slug - Detail view
  app.get("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const rawQuery = detailQuery.parse(req.query || {});
    const cacheKey = `figures:detail:${slug}:${rawQuery.lang || "all"}`;

    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const figure = await app.prisma.figure.findFirst({
      where: { isDeleted: false, OR: sourceSlugFallbacks(slug) },
      include: {
        manufacturer: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true, country: true, website: true } },
        series: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true, mediaType: true } },
        characters: { include: { character: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true } } } },
        sculptors: { include: { sculptor: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true } } } },
        categories: { include: { category: { select: { id: true, slug: true, name: true } } } },
        localized: {
          where: rawQuery.lang ? { language: rawQuery.lang } : undefined,
        },
        releases: {
          orderBy: { releaseDate: "asc" },
        },
        images: {
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          select: {
            id: true, alt: true, size: true, format: true, sha256: true,
            width: true, height: true, blurhash: true, fileSize: true,
            sortOrder: true, source: true,
        data: true, isNsfw: true, janCode: true,
          },
        },
        revisions: { where: { isActive: true }, take: 1 },
      },
    });

    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND", message: "Figure not found" } });

    // Build one display image per source image, with thumb/raw/detail variants attached.
    const transformedImages = groupImageVariants(figure.images || []);
    const mainImage = transformedImages[0] || null;

    // Build lineage
    let lineage: any = null;
    const descendants = await app.prisma.figure.findMany({
      where: { parentId: figure.id, isDeleted: false },
      select: { id: true, slug: true, name: true, releaseDate: true },
    });
    const ancestors: any[] = [];
    if (figure.parentId) {
      let cur = figure;
      while (cur.parentId) {
        const p = await app.prisma.figure.findFirst({
          where: { id: cur.parentId, isDeleted: false },
          select: { id: true, slug: true, name: true, releaseDate: true, parentId: true },
        });
        if (p) { ancestors.unshift(p); cur = p as any; } else break;
      }
    }
    lineage = { ancestors, descendants };

    const result = { success: true, data: publicFigure({ ...figure, image: mainImage, images: transformedImages, lineage }) };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
    return result;
  });

  // GET /:slug/lineage
  app.get("/:slug/lineage", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const figure = await app.prisma.figure.findFirst({ where: { slug, isDeleted: false }, select: { id: true, slug: true, name: true, releaseDate: true } });
    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });

    const ancestors: any[] = [];
    let current = await app.prisma.figure.findFirst({ where: { id: figure.id, isDeleted: false }, select: { parentId: true } });
    while (current?.parentId) {
      const parent = await app.prisma.figure.findFirst({
        where: { id: current.parentId, isDeleted: false },
        select: { id: true, slug: true, name: true, releaseDate: true, parentId: true },
      });
      if (parent) { ancestors.unshift(parent); current = parent; } else break;
    }

    const descendants = await app.prisma.figure.findMany({
      where: { parentId: figure.id, isDeleted: false },
      select: { id: true, slug: true, name: true, releaseDate: true },
    });

    return { success: true, data: { current: figure, ancestors, descendants } };
  });

  // GET /:slug/revisions
  app.get("/:slug/revisions", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const figure = await app.prisma.figure.findFirst({ where: { slug, isDeleted: false }, select: { id: true } });
    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });

    const revisions = await app.prisma.revision.findMany({
      where: { figureId: figure.id },
      select: { id: true, versionNumber: true, editSummary: true, editorId: true, isActive: true, createdAt: true },
      orderBy: { versionNumber: "desc" },
    });
    return { success: true, data: revisions };
  });

  // POST / - Create figure
  app.post("/", async (req: any, reply: any) => {
    const data = createFigureSchema.parse(req.body);
    const { categoryIds, sculptorIds, characterIds, images, localized, releases, releaseDate, ...figureData } = data;

    const figure = await app.prisma.figure.create({
      data: {
        ...figureData,
        releaseDate: releaseDate ? new Date(releaseDate) : undefined,
        categories: { create: categoryIds?.map((categoryId: number) => ({ category: { connect: { id: categoryId } } })) || [] },
        sculptors: { create: sculptorIds?.map((s: any) => ({ sculptor: { connect: { id: s.id } }, role: s.role, isPrimary: s.isPrimary ?? false })) || [] },
        characters: { create: characterIds?.map((c: any) => ({ character: { connect: { id: c.id } }, isFeatured: c.isFeatured ?? false })) || [] },
        localized: { create: localized?.map((loc: any) => ({ language: loc.language, title: loc.title, origin: loc.origin, character: loc.character, description: loc.description })) || [] },
        releases: { create: releases?.map((rel: any) => ({ edition: rel.edition, releaseDate: rel.releaseDate ? new Date(rel.releaseDate) : undefined, priceJpy: rel.priceJpy ?? undefined, isRerelease: rel.isRerelease ?? false })) || [] },
      },
    });

    const imageImport = { created: 0, errors: [] as Array<{ source: string; error: string }> };

    // Process and store images via the image pipeline
    if (images && images.length > 0) {
      const janCode = figureData.janCode || figure.janCode || "no-jancode";
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        try {
          const imageRecords = await processAndStoreImage(img.source, janCode, {
            alt: img.alt,
            sortOrder: img.sortOrder ?? i,
          });
          // Create FigureImage DB records from the returned data
          for (const rec of imageRecords) {
            const result = await upsertFigureImageRecord(app, {
              figureId: figure.id,
              janCode: rec.janCode,
              sha256: rec.sha256,
              size: rec.size,
              format: rec.format,
              width: rec.width,
              height: rec.height,
              fileSize: rec.fileSize,
              alt: rec.alt || null,
              sortOrder: rec.sortOrder,
              source: rec.source,
              isNsfw: rec.isNsfw || false,
            });
            if (result.created) imageImport.created += 1;
          }
        } catch (err: any) {
          app.log.error({ err, source: img.source }, "Failed to process image during figure creation");
          imageImport.errors.push({ source: img.source, error: err?.message || "Image processing failed" });
        }
      }
    }

    await invalidateFigureCache(app);

    return reply.status(201).send({ success: true, data: figure, meta: { imageImport } });
  });

  // PUT /:slug - Update figure
  app.put("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };
    const data = updateFigureSchema.parse(req.body);
    const { categoryIds, sculptorIds, characterIds, images, localized, releases, releaseDate, ...figureData } = data;

    const existing = await app.prisma.figure.findFirst({ where: { slug, isDeleted: false } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });

    if (data.slug && data.slug !== slug) {
      const slugExists = await app.prisma.figure.findUnique({ where: { slug: data.slug }, select: { id: true } });
      if (slugExists) {
        return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
      }
    }

    const updateData: any = {
      ...figureData,
      releaseDate: releaseDate !== undefined ? (releaseDate ? new Date(releaseDate) : null) : undefined,
    };

    // Handle nullable fields explicitly set to null
    for (const [key, value] of Object.entries(figureData)) {
      if (value === null) {
        updateData[key] = null;
      }
    }

    if (categoryIds !== undefined) {
      updateData.categories = {
        deleteMany: {},
        create: categoryIds.map((categoryId: number) => ({ category: { connect: { id: categoryId } } })),
      };
    }

    if (sculptorIds !== undefined) {
      updateData.sculptors = {
        deleteMany: {},
        create: sculptorIds.map((s: any) => ({ sculptor: { connect: { id: s.id } }, role: s.role, isPrimary: s.isPrimary ?? false })),
      };
    }

    if (characterIds !== undefined) {
      updateData.characters = {
        deleteMany: {},
        create: characterIds.map((c: any) => ({ character: { connect: { id: c.id } }, isFeatured: c.isFeatured ?? false })),
      };
    }

    // Upsert localized records: delete existing and recreate
    if (localized !== undefined) {
      updateData.localized = {
        deleteMany: {},
        create: localized.map((loc: any) => ({
          language: loc.language,
          title: loc.title,
          origin: loc.origin,
          character: loc.character,
          description: loc.description,
        })),
      };
    }

    // Replace releases
    if (releases !== undefined) {
      updateData.releases = {
        deleteMany: {},
        create: releases.map((rel: any) => ({
          edition: rel.edition,
          releaseDate: rel.releaseDate ? new Date(rel.releaseDate) : undefined,
          priceJpy: rel.priceJpy ?? undefined,
          isRerelease: rel.isRerelease ?? false,
        })),
      };
    }

    const figure = await app.prisma.figure.update({
      where: { slug },
      data: updateData,
    });

    const imageImport = { created: 0, errors: [] as Array<{ source: string; error: string }> };

    // Add new images (does not remove existing ones)
    if (images && images.length > 0) {
      const janCode = (figureData.janCode ?? existing.janCode) || "no-jancode";
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        try {
          const imageRecords = await processAndStoreImage(img.source, janCode, {
            alt: img.alt,
            sortOrder: img.sortOrder ?? i,
          });
          for (const rec of imageRecords) {
            const result = await upsertFigureImageRecord(app, {
              figureId: figure.id,
              janCode: rec.janCode,
              sha256: rec.sha256,
              size: rec.size,
              format: rec.format,
              width: rec.width,
              height: rec.height,
              fileSize: rec.fileSize,
              alt: rec.alt || null,
              sortOrder: rec.sortOrder,
              source: rec.source,
              isNsfw: rec.isNsfw || false,
            });
            if (result.created) imageImport.created += 1;
          }
        } catch (err: any) {
          app.log.error({ err, source: img.source }, "Failed to process image during figure update");
          imageImport.errors.push({ source: img.source, error: err?.message || "Image processing failed" });
        }
      }
    }

    await invalidateFigureCache(app, slug);
    if (figure.slug !== slug) {
      await app.redis.del(`figures:detail:${figure.slug}`);
    }

    return { success: true, data: figure, meta: { imageImport } };
  });

  // DELETE /:slug - Soft delete
  app.delete("/:slug", async (req: any, reply: any) => {
    const { slug } = req.params as { slug: string };

    const existing = await app.prisma.figure.findFirst({ where: { slug, isDeleted: false } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });

    await app.prisma.figure.update({ where: { slug }, data: { isDeleted: true } });

    await invalidateFigureCache(app, slug);

    return { success: true, data: { deleted: true } };
  });
}
