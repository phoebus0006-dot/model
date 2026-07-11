import type { Redis } from "ioredis";
import type { PrismaClient } from "@prisma/client";
import { processAndStoreImage, upsertFigureImageRecord } from "../../modules/images/image-service.js";
import { computeReviewEvidenceFingerprint, reviewDecisionKey, reviewFigureKey, reviewRiskKey } from "./service.js";
import { isSuppressingAction } from "./types.js";
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

export interface ApplyOutput {
  action: string;
  figure?: { id: number; slug: string };
  imageImport?: { created: number; errors: Array<{ source: string; error: string }> };
  deleted?: number;
  imageId?: number | null;
  source?: string;
  processedCount?: number;
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
        for (const rec of imageRecords) {
          if (rec.sha256 && imageImport.created === 0) {
            imageImport.created++;
          }
        }
      } catch (err: any) {
        imageImport.errors.push({ source: img.source, error: err?.message || "Image processing failed" });
      }
    }
  }

  return {
    action: existingFigure ? "figure_updated" : "figure_created",
    figure: { id: Number(savedFigure.id), slug: savedFigure.slug },
    imageImport,
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
    return { action: "already_approved", figure: { id: Number(figure.id), slug: figure.slug }, imageId: Number(existing.id), source: cand.source };
  }

  const janCode = figure.janCode || "no-jancode";
  let firstImageId: number | null = null;
  let processedCount = 0;

  try {
    const imageRecords = await processAndStoreImage(cand.source, janCode, prisma, {
      sortOrder: 0,
      isNsfw: false,
      figureId: figure.id,
    });
    processedCount = imageRecords.length;
    firstImageId = Number(figure.id); // placeholder
  } catch {
    await upsertFigureImageRecord(prisma, {
      figureId: figure.id,
      janCode,
      sha256: null,
      size: "raw",
      format: "jpg",
      width: cand.width || null,
      height: cand.height || null,
      fileSize: null,
      alt: null,
      sortOrder: 0,
      source: cand.source,
      isNsfw: false,
    });
    firstImageId = Number(figure.id);
    processedCount = 1;
  }

  return { action: "image_approved", figure: { id: Number(figure.id), slug: figure.slug }, imageId: firstImageId, source: cand.source, processedCount };
}

export async function applyItemStatus(context: ApplyContext, id: string, item: any, output: ApplyOutput): Promise<void> {
  const problems = await evaluateReviewItem(context, item);
  const now = new Date().toISOString();
  const updatedItem = {
    ...item,
    payload: { ...(item.payload || {}), reviewProblems: problems, lastCheckedAt: now },
    status: problems.length === 0 ? "resolved" : "needs_changes",
    notes: problems.length === 0
      ? (item.notes ? `${item.notes}\nApplied and rechecked at ${now}` : `Applied and rechecked at ${now}`)
      : (item.notes ? `${item.notes}\nApplied but still needs changes: ${problems.join("; ")}` : `Applied but still needs changes: ${problems.join("; ")}`),
    updatedAt: now,
  };
  await context.redis.set(`review:item:${id}`, JSON.stringify(updatedItem));
  await scanKeys(context.redis as any, "figures:*");
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
      select: { id: true, source: true, size: true, width: true, height: true, sha256: true },
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
