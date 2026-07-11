import type { Redis } from "ioredis";
import type { PrismaClient } from "@prisma/client";
import { processAndStoreImage, upsertFigureImageRecord } from "../../modules/images/image-service.js";
import { scanKeys } from "../../shared/cache/scan-keys.js";

export interface ApplyContext {
  redis: Redis;
  prisma: PrismaClient;
}

export interface ApplyActor {
  userId: string;
  displayName: string;
}

export interface ApplyInput {
  context: ApplyContext;
  item: any;
  id: string;
  actor: ApplyActor;
  body: Record<string, unknown>;
  action: string;
}

export interface ApplyFailure {
  stage: string;
  problems: string[];
}

export interface ApplyOutput {
  success: boolean;
  action: string;
  figure?: { id: string; slug: string };
  reviewStatus?: string;
  imageImport?: { created: number; errors: Array<{ source: string; error: string }> };
  deleted?: number;
  imageId?: string | null;
  source?: string;
  processedCount?: number;
  failure?: ApplyFailure;
}

async function resolveFigure(prisma: PrismaClient, item: any): Promise<any | null> {
  const figureWhere = item.figureSlug
    ? { slug: item.figureSlug, isDeleted: false }
    : item.figureId
      ? { id: BigInt(item.figureId), isDeleted: false }
      : null;
  if (!figureWhere) return null;
  return prisma.figure.findFirst({ where: figureWhere as any });
}

export async function applyFigureImport(input: ApplyInput): Promise<ApplyOutput> {
  const { prisma } = input.context;
  const payload = input.item.payload || {};
  const figurePayload = payload.figure || {};

  if (!figurePayload.slug || !figurePayload.name) {
    throw Object.assign(new Error("MISSING_FIGURE_PAYLOAD"), { code: "MISSING_FIGURE_PAYLOAD" });
  }

  const { categoryIds, sculptorIds, characterIds, images, localized, releases, releaseDate, ...figureData } = figurePayload;
  const matchOr: any[] = [{ slug: figurePayload.slug }];
  if (figurePayload.janCode) matchOr.push({ janCode: figurePayload.janCode });
  const existingFigure = await prisma.figure.findFirst({
    where: { isDeleted: false, OR: matchOr },
    select: { id: true, slug: true },
  });

  const relationData: any = {
    releaseDate: releaseDate ? new Date(releaseDate) : undefined,
    categories: categoryIds ? { deleteMany: {}, create: categoryIds.map((categoryId: number) => ({ category: { connect: { id: categoryId } } })) } : undefined,
    sculptors: sculptorIds ? { deleteMany: {}, create: sculptorIds.map((s: any) => ({ sculptor: { connect: { id: s.id } }, role: s.role, isPrimary: s.isPrimary ?? false })) } : undefined,
    characters: characterIds ? { deleteMany: {}, create: characterIds.map((c: any) => ({ character: { connect: { id: c.id } }, isFeatured: c.isFeatured ?? false })) } : undefined,
    localized: localized ? { deleteMany: {}, create: localized.map((loc: any) => ({ language: loc.language, title: loc.title, origin: loc.origin, character: loc.character, description: loc.description })) } : undefined,
    releases: releases ? { deleteMany: {}, create: releases.map((rel: any) => ({ edition: rel.edition, releaseDate: rel.releaseDate ? new Date(rel.releaseDate) : undefined, priceJpy: rel.priceJpy ?? undefined, isRerelease: rel.isRerelease ?? false })) } : undefined,
  };
  Object.keys(relationData).forEach((key) => relationData[key] === undefined && delete relationData[key]);

  const savedFigure = existingFigure
    ? await prisma.figure.update({ where: { id: existingFigure.id }, data: { ...figureData, ...relationData } })
    : await prisma.figure.create({
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
  if (payload.importImages !== false && images && images.length > 0) {
    const janCode = figurePayload.janCode || savedFigure.janCode || "no-jancode";
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        const imageRecords = await processAndStoreImage(img.source, janCode, prisma, {
          alt: img.alt,
          sortOrder: img.sortOrder ?? i,
          figureId: savedFigure.id,
        });
        imageImport.created += imageRecords.length;
      } catch (err: any) {
        imageImport.errors.push({ source: img.source, error: err?.message || "Image processing failed" });
      }
    }
  }

  const allFailed = images && images.length > 0 && imageImport.errors.length === images.length;
  return {
    success: !allFailed,
    action: existingFigure ? "figure_updated" : "figure_created",
    figure: { id: String(savedFigure.id), slug: savedFigure.slug },
    imageImport,
    failure: allFailed ? { stage: "image", problems: ["All images failed to process"] } : undefined,
  };
}

export async function applyImageReview(input: ApplyInput): Promise<ApplyOutput> {
  const { prisma } = input.context;
  const item = input.item;
  const action = input.action;

  if (action !== "approve_image") {
    throw Object.assign(new Error("UNSUPPORTED_ACTION"), { code: "UNSUPPORTED_ACTION" });
  }

  const figure = await resolveFigure(prisma, item);
  if (!figure) {
    throw Object.assign(new Error("FIGURE_NOT_FOUND"), { code: "FIGURE_NOT_FOUND" });
  }

  const cand = item.candidateImage;
  if (!cand || !cand.source) {
    throw Object.assign(new Error("MISSING_CANDIDATE_IMAGE"), { code: "MISSING_CANDIDATE_IMAGE" });
  }

  const existing = await prisma.figureImage.findFirst({
    where: { figureId: figure.id, source: cand.source },
    select: { id: true, source: true },
  });

  if (existing) {
    await prisma.figureImage.update({
      where: { id: existing.id },
      data: {
        data: { source_kind: "mfc_review_approved", safe_display: true, image_low_quality: false, reviewed_by_admin: true, review_item_id: item.id },
        sortOrder: 0,
      },
    });
    return { success: true, action: "already_approved", figure: { id: String(figure.id), slug: figure.slug }, imageId: String(existing.id), source: cand.source };
  }

  const janCode = figure.janCode || "no-jancode";
  let firstImageId: string | null = null;

  try {
    const imageRecords = await processAndStoreImage(cand.source, janCode, prisma, {
      sortOrder: 0,
      isNsfw: false,
      figureId: figure.id,
    });
    for (const rec of imageRecords) {
      if (firstImageId === null && rec.sha256) {
        const result = await upsertFigureImageRecord(prisma, {
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
        firstImageId = String(result.image.id);
      }
    }
  } catch (err: any) {
    return {
      success: false,
      action: "image_approve_failed",
      figure: { id: String(figure.id), slug: figure.slug },
      failure: { stage: "image_download", problems: [err?.message || "Image download/process failed"] },
    };
  }

  return { success: true, action: "image_approved", figure: { id: String(figure.id), slug: figure.slug }, imageId: firstImageId, source: cand.source, processedCount: firstImageId ? 1 : 0 };
}

export async function applyItemStatus(context: ApplyContext, id: string, item: any, output: ApplyOutput): Promise<string> {
  const problems = await evaluateReviewItem(context, item);
  const now = new Date().toISOString();
  const businessFailed = output.failure || problems.length > 0;
  const newStatus = businessFailed ? "needs_changes" : "resolved";
  const updatedItem = {
    ...item,
    payload: { ...(item.payload || {}), reviewProblems: problems, lastCheckedAt: now },
    status: newStatus,
    notes: problems.length === 0
      ? (item.notes ? `${item.notes}\nApplied and rechecked at ${now}` : `Applied and rechecked at ${now}`)
      : (item.notes ? `${item.notes}\nApplied but needs changes: ${problems.join("; ")}` : `Applied but needs changes: ${problems.join("; ")}`),
    updatedAt: now,
  };
  await context.redis.set(`review:item:${id}`, JSON.stringify(updatedItem));
  await scanKeys(context.redis as any, "figures:*");
  return newStatus;
}

async function evaluateReviewItem(context: ApplyContext, item: any): Promise<string[]> {
  const { prisma } = context;
  const payload = item.payload || {};
  const problems: string[] = [];
  const figure = await resolveFigure(prisma, item);

  if (["image", "image_review", "rewrite", "jan_match", "detail_review"].includes(item.type) && !figure) {
    problems.push("FIGURE_NOT_FOUND");
    return problems;
  }

  if (item.type === "image" && figure) {
    const rows = await prisma.figureImage.findMany({
      where: { figureId: figure.id },
      select: { id: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    if (rows.length === 0) problems.push("仍然没有图片");
  }

  if (item.type === "figure_import") {
    const slug = payload.figure?.slug || payload.slug || item.figureSlug;
    if (slug) {
      const existing = await prisma.figure.findFirst({ where: { slug: String(slug), isDeleted: false }, select: { id: true } });
      if (!existing) problems.push("候选手办仍未入库");
    } else {
      problems.push("候选内容缺少 slug");
    }
  }

  return problems;
}
