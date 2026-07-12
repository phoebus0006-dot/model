import type { Redis } from "ioredis";
import type { PrismaClient } from "@prisma/client";
import { processAndStoreImage, upsertFigureImageRecord } from "../../modules/images/image-service.js";
import { scanKeys } from "../../shared/cache/scan-keys.js";
import { ApplyDependencyError, ApplyValidationError } from "./apply-errors.js";
import type { FigureImportDTO, JanMatchDTO, RewriteDTO, ImageDTO, ImageReviewDTO } from "./apply-schemas.js";

export interface ApplyContext {
  redis: Redis;
  prisma: PrismaClient;
  verifyLock(): Promise<void>;
}

export interface ApplyActor {
  userId: string;
  displayName: string;
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
  revision?: { id: string; versionNumber: number };
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

export async function applyFigureImport(
  context: ApplyContext,
  item: any,
  id: string,
  actor: ApplyActor,
  dto: FigureImportDTO,
  action: string,
): Promise<ApplyOutput> {
  const { prisma } = context;
  const { images, categoryIds, sculptorIds, characterIds, localized, releases, importImages, ...figureFields } = dto;

  if (!figureFields.slug || !figureFields.name) {
    throw new ApplyValidationError("slug and name are required for figure_import");
  }

  const slugFig = figureFields.slug
    ? await prisma.figure.findFirst({ where: { slug: figureFields.slug, isDeleted: false }, select: { id: true, slug: true, janCode: true } })
    : null;
  const janFig = figureFields.janCode
    ? await prisma.figure.findFirst({ where: { janCode: figureFields.janCode, isDeleted: false }, select: { id: true, slug: true, janCode: true } })
    : null;

  if (slugFig && janFig && slugFig.id !== janFig.id) {
    throw new ApplyDependencyError("figure", "FIGURE_IDENTITY_CONFLICT: slug and JAN point to different figures");
  }

  const existingFigure = slugFig || janFig;

  const figureData: any = {
    slug: figureFields.slug,
    name: figureFields.name,
    nameJp: figureFields.nameJp ?? null,
    nameEn: figureFields.nameEn ?? null,
    janCode: figureFields.janCode ?? null,
    scale: figureFields.scale ?? null,
    material: figureFields.material ?? null,
    priceJpy: figureFields.priceJpy ?? null,
    heightMm: figureFields.heightMm ?? null,
    weightG: figureFields.weightG ?? null,
    description: figureFields.description ?? null,
    productLine: figureFields.productLine ?? null,
    mfcId: figureFields.mfcId ?? null,
    ageRating: figureFields.ageRating ?? null,
    hobbySearchId: figureFields.hobbySearchId ?? null,
    amiamiId: figureFields.amiamiId ?? null,
    hljId: figureFields.hljId ?? null,
  };

  if (figureFields.releaseDate) {
    figureData.releaseDate = new Date(figureFields.releaseDate);
  }

  const relationData: any = {};
  if (categoryIds) {
    relationData.categories = { deleteMany: {}, create: categoryIds.map((categoryId: number) => ({ category: { connect: { id: categoryId } } })) };
  }
  if (sculptorIds) {
    relationData.sculptors = { deleteMany: {}, create: sculptorIds.map((s: any) => ({ sculptor: { connect: { id: s.id } }, role: s.role, isPrimary: s.isPrimary ?? false })) };
  }
  if (characterIds) {
    relationData.characters = { deleteMany: {}, create: characterIds.map((c: any) => ({ character: { connect: { id: c.id } }, isFeatured: c.isFeatured ?? false })) };
  }
  if (localized) {
    relationData.localized = { deleteMany: {}, create: localized.map((loc: any) => ({ language: loc.language, title: loc.title, origin: loc.origin, character: loc.character, description: loc.description })) };
  }
  if (releases) {
    relationData.releases = { deleteMany: {}, create: releases.map((rel: any) => ({ edition: rel.edition, releaseDate: rel.releaseDate ? new Date(rel.releaseDate) : undefined, priceJpy: rel.priceJpy ?? undefined, isRerelease: rel.isRerelease ?? false })) };
  }

  await context.verifyLock();
  const savedFigure = existingFigure
    ? await prisma.figure.update({ where: { id: existingFigure.id }, data: { ...figureData, ...relationData } })
    : await prisma.figure.create({ data: { ...figureData, ...relationData } });

  const imageImport = { created: 0, errors: [] as Array<{ source: string; error: string }> };
  if (importImages !== false && images && images.length > 0) {
    const janCode = figureFields.janCode || savedFigure.janCode || "no-jancode";
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        await context.verifyLock();
        const imageRecords = await processAndStoreImage(img.source, janCode, prisma, {
          alt: img.alt, sortOrder: img.sortOrder ?? i, figureId: savedFigure.id,
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

export async function applyJanMatch(
  context: ApplyContext,
  item: any,
  id: string,
  actor: ApplyActor,
  dto: JanMatchDTO,
  action: string,
): Promise<ApplyOutput> {
  const { prisma } = context;

  if (!dto.janCode) {
    throw new ApplyValidationError("janCode is required for jan_match");
  }

  const targetFig = await prisma.figure.findFirst({ where: { janCode: dto.janCode, isDeleted: false }, select: { id: true, slug: true } });
  if (!targetFig) {
    throw new ApplyDependencyError("figure", `FIGURE_NOT_FOUND: no figure with janCode ${dto.janCode}`);
  }

  const existing = await prisma.figure.findFirst({
    where: { slug: item.figureSlug, isDeleted: false },
    select: { id: true, slug: true, janCode: true },
  });
  if (!existing) {
    throw new ApplyDependencyError("figure", "FIGURE_NOT_FOUND: source figure not found");
  }

  if (existing.id === targetFig.id) {
    return { success: true, action: "jan_already_matched", figure: { id: String(existing.id), slug: existing.slug } };
  }

  await context.verifyLock();
  await prisma.figure.update({
    where: { id: existing.id },
    data: { janCode: dto.janCode, parentId: targetFig.id },
    select: { id: true },
  });

  return {
    success: true,
    action: "jan_matched",
    figure: { id: String(existing.id), slug: existing.slug },
  };
}

export async function applyRewrite(
  context: ApplyContext,
  item: any,
  id: string,
  actor: ApplyActor,
  dto: RewriteDTO,
  action: string,
): Promise<ApplyOutput> {
  const { prisma } = context;

  const figure = await resolveFigure(prisma, item);
  if (!figure) {
    throw new ApplyDependencyError("revision", "FIGURE_NOT_FOUND");
  }

  const currentVersion = await prisma.revision.findFirst({
    where: { figureId: figure.id },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  const nextVersion = (currentVersion?.versionNumber || 0) + 1;

  await context.verifyLock();
  const revision = await prisma.revision.create({
    data: {
      figureId: figure.id,
      contentMd: dto.contentMd || "",
      summaryMd: dto.summaryMd || null,
      keyPoints: dto.keyPoints || [],
      relatedKeywords: dto.relatedKeywords || [],
      versionNumber: nextVersion,
      editSummary: dto.editSummary || `Apply rewrite review item ${id}`,
      isActive: true,
    },
    select: { id: true, versionNumber: true },
  });

  await context.verifyLock();
  await prisma.figure.update({
    where: { id: figure.id },
    data: { activeRevisionId: revision.id },
  });

  return {
    success: true,
    action: "rewrite_applied",
    figure: { id: String(figure.id), slug: figure.slug },
    revision: { id: String(revision.id), versionNumber: nextVersion },
  };
}

export async function applyImage(
  context: ApplyContext,
  item: any,
  id: string,
  actor: ApplyActor,
  dto: ImageDTO,
  action: string,
): Promise<ApplyOutput> {
  const { prisma } = context;

  const figure = await resolveFigure(prisma, item);
  if (!figure) {
    throw new ApplyDependencyError("image", "FIGURE_NOT_FOUND");
  }

  const janCode = figure.janCode || "no-jancode";
  let firstImageId: string | null = null;
  const imageImport = { created: 0, errors: [] as Array<{ source: string; error: string }> };

  try {
    await context.verifyLock();
    const imageRecords = await processAndStoreImage(dto.source, janCode, prisma, {
      alt: dto.alt, sortOrder: dto.sortOrder ?? 0, isNsfw: dto.isNsfw,
      figureId: figure.id,
    });
    for (const rec of imageRecords) {
      if (firstImageId === null && rec.sha256) {
        await context.verifyLock();
        const result = await upsertFigureImageRecord(prisma, {
          figureId: figure.id, janCode: rec.janCode, sha256: rec.sha256,
          size: rec.size, format: rec.format, width: rec.width, height: rec.height,
          fileSize: rec.fileSize, alt: rec.alt || null, sortOrder: rec.sortOrder,
          source: rec.source, isNsfw: rec.isNsfw,
        });
        firstImageId = String(result.image.id);
      }
    }
    imageImport.created = imageRecords.length;
  } catch (err: any) {
    imageImport.errors.push({ source: dto.source, error: err?.message || "Image processing failed" });
  }

  if (imageImport.errors.length > 0) {
    return {
      success: false,
      action: "image_failed",
      figure: { id: String(figure.id), slug: figure.slug },
      imageImport,
      failure: { stage: "image_download", problems: imageImport.errors.map(e => e.error) },
    };
  }

  return {
    success: true,
    action: "image_imported",
    figure: { id: String(figure.id), slug: figure.slug },
    imageId: firstImageId,
    source: dto.source,
    processedCount: imageImport.created,
  };
}

export async function applyImageReview(
  context: ApplyContext,
  item: any,
  id: string,
  actor: ApplyActor,
  dto: ImageReviewDTO,
  action: string,
): Promise<ApplyOutput> {
  const { prisma } = context;

  if (action !== "approve_image") {
    throw new ApplyValidationError("UNSUPPORTED_ACTION: only approve_image is supported");
  }

  const figure = await resolveFigure(prisma, item);
  if (!figure) {
    throw new ApplyDependencyError("image", "FIGURE_NOT_FOUND");
  }

  const cand = item.candidateImage;
  if (!cand || !cand.source) {
    throw new ApplyValidationError("MISSING_CANDIDATE_IMAGE");
  }

  const existing = await prisma.figureImage.findFirst({
    where: { figureId: figure.id, source: cand.source },
    select: { id: true, source: true },
  });

  if (existing) {
    await context.verifyLock();
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
    await context.verifyLock();
    const imageRecords = await processAndStoreImage(cand.source, janCode, prisma, {
      sortOrder: 0, isNsfw: false, figureId: figure.id,
    });
    for (const rec of imageRecords) {
      if (firstImageId === null && rec.sha256) {
        await context.verifyLock();
        const result = await upsertFigureImageRecord(prisma, {
          figureId: figure.id, janCode: rec.janCode, sha256: rec.sha256,
          size: rec.size, format: rec.format, width: rec.width, height: rec.height,
          fileSize: rec.fileSize, alt: rec.alt || null, sortOrder: rec.sortOrder,
          source: rec.source, isNsfw: rec.isNsfw,
        });
        firstImageId = String(result.image.id);
      }
    }
  } catch (err: any) {
    return {
      success: false, action: "image_approve_failed",
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
  await context.verifyLock();
  await context.redis.set(`review:item:${id}`, JSON.stringify(updatedItem));
  await context.verifyLock();
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
