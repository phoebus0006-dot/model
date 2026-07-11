// Auto-extracted from admin.ts - review apply handler
import { FastifyInstance } from "fastify";
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import sharp from "sharp";
import { processAndStoreImage, upsertFigureImageRecord } from "../../routes/images.js";
import { computeReviewEvidenceFingerprint, reviewDecisionKey, reviewFigureKey, reviewRiskKey } from "./service.js";
import { isSuppressingAction } from "./types.js";
import { scanKeys } from "../../shared/cache/scan-keys.js";

const ASSETS_PATH = process.env.ASSETS_PATH || "/app/assets";
const REVIEW_IMAGE_SIZES = new Set(["raw", "detail", "thumb"]);

function getReviewImageFilePath(janCode: string, sha256: string, size: string): string {
  return path.join(ASSETS_PATH, "figures", janCode, sha256 + "_" + size + ".webp");
}

async function storeProcessedReviewImage(app: FastifyInstance, figureId: bigint, janCode: string, data: any) {
  const size = String(data.size || "");
  const sha256 = String(data.sha256 || "");
  if (!REVIEW_IMAGE_SIZES.has(size)) throw new Error("Invalid processed image size: " + size);
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Invalid processed image sha256");
  if (!data.contentBase64) throw new Error("Missing processed image contentBase64");
  const buffer = Buffer.from(String(data.contentBase64), "base64");
  if (!buffer.length) throw new Error("Processed image content is empty");
  const filePath = getReviewImageFilePath(janCode, sha256, size);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  const payload = { figureId, janCode, sha256, size, format: data.format || "webp", width: data.width ?? null, height: data.height ?? null, fileSize: data.fileSize || buffer.length, alt: data.alt || null, sortOrder: data.sortOrder ?? 0, source: data.source || null, isNsfw: data.isNsfw || false };
  const { image, created } = await upsertFigureImageRecord(app, payload);
  return { image, sha256, updated: !created };
}

async function resolveReviewFigure(app: FastifyInstance, item: any, payload: any) {
  const slug = item.figureSlug || payload.figureSlug || payload.slug || payload.figure?.slug;
  const id = item.figureId || payload.figureId || payload.figure?.id;
  if (id !== undefined && id !== null && /^\d+$/.test(String(id))) {
    const byId = await app.prisma.figure.findFirst({ where: { id: BigInt(id), isDeleted: false }, select: { id: true, slug: true, name: true, janCode: true, activeRevisionId: true } });
    if (byId) return byId;
  }
  if (slug) return app.prisma.figure.findFirst({ where: { slug: String(slug), isDeleted: false }, select: { id: true, slug: true, name: true, janCode: true, activeRevisionId: true } });
  return null;
}

async function evaluateReviewItem(app: FastifyInstance, item: any) {
  const payload = item.payload || {};
  const problems: string[] = [];
  const figure = await resolveReviewFigure(app, item, payload);

  if (["image", "image_review", "rewrite", "jan_match", "detail_review"].includes(item.type) && !figure) {
    problems.push("FIGURE_NOT_FOUND");
    return problems;
  }

  if (item.type === "image" && figure) {
    const rows = await app.prisma.figureImage.findMany({
      where: { figureId: figure.id },
      select: { id: true, source: true, size: true, width: true, height: true, sha256: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    if (rows.length === 0) problems.push("仍然没有图片");

    const sourceSizeCounts = new Map<string, number>();
    for (const row of rows) {
      if (!row.source) continue;
      const key = `${row.source}::${row.size}`;
      sourceSizeCounts.set(key, (sourceSizeCounts.get(key) || 0) + 1);
    }
    const duplicateGroups = [...sourceSizeCounts.values()].filter((count) => count > 1).length;
    if (duplicateGroups > 0) problems.push(`同一来源同一尺寸仍有 ${duplicateGroups} 组重复图片记录`);

    const issue = String(payload.issue || payload.issueType || payload.reason || "").toLowerCase();
    if (issue.includes("low") || issue.includes("resolution") || issue.includes("糊")) {
      const bestWidth = Math.max(...rows.map((row: any) => Number(row.width) || 0), 0);
      if (bestWidth > 0 && bestWidth < 600) problems.push(`最高图片宽度只有 ${bestWidth}px，仍可能过糊`);
    }
  } else if (item.type === "image_review" && figure) {
    // P2: image_review recheck — verify approve actually produced a high-quality main image
    const rows = await app.prisma.figureImage.findMany({
      where: { figureId: figure.id },
      select: { id: true, source: true, size: true, width: true, height: true, sha256: true, sortOrder: true, data: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    if (rows.length === 0) {
      problems.push("仍然没有图片");
    } else {
      // Dedup check
      const sourceSizeCounts = new Map<string, number>();
      for (const row of rows) {
        if (!row.source) continue;
        const key = `${row.source}::${row.size}`;
        sourceSizeCounts.set(key, (sourceSizeCounts.get(key) || 0) + 1);
      }
      const duplicateGroups = [...sourceSizeCounts.values()].filter((count) => count > 1).length;
      if (duplicateGroups > 0) problems.push(`同一来源同一尺寸仍有 ${duplicateGroups} 组重复图片记录`);

      const riskType = String(item.riskType || "");
      // For image_low_count: approved image must be high-quality and present
      if (riskType === "image_low_count") {
        // Find approved/trusted image (the one that should be the main display image)
        const approved = rows.find((r: any) => {
          const kind = String((r.data || {}).source_kind || "");
          return kind === "mfc_review_approved" || kind === "trusted_retailer_image";
        });
        if (!approved) {
          problems.push("没有 mfc_review_approved 或可信 retailer 高清图，批准未生效");
        } else {
          const w = Number(approved.width) || 0;
          const h = Number(approved.height) || 0;
          if (w < 500 || h < 500) {
            problems.push(`主图尺寸 ${w}x${h} 不足 500x500，仍为低清`);
          }
          const kind = String(((approved.data || {}) as any).source_kind || "");
          if (kind !== "mfc_review_approved" && kind !== "trusted_retailer_image") {
            problems.push(`主图 source_kind=${kind} 不是 mfc_review_approved 或可信 retailer`);
          }
          if (((approved.data || {}) as any).image_low_quality === true) {
            problems.push("主图仍标记 image_low_quality=true");
          }
        }
      }
      // For image_missing: if still no images, problem remains
      if (riskType === "image_missing" && rows.length === 0) {
        problems.push("仍然没有图片");
      }
    }
  } else if (item.type === "rewrite" && figure) {
    const activeRevision = await app.prisma.revision.findFirst({
      where: { figureId: figure.id, isActive: true },
      select: { id: true, contentMd: true },
    });
    if (!activeRevision || !activeRevision.contentMd || activeRevision.contentMd.trim().length < 80) problems.push("洗稿正文仍为空或过短");
  } else if (item.type === "detail_review" && figure) {
    const figureDetail = await app.prisma.figure.findUnique({
      where: { id: figure.id },
      select: {
        id: true, description: true, scale: true, material: true,
        priceJpy: true, releaseDate: true, heightMm: true, weightG: true,
        productLine: true, ageRating: true,
        manufacturer: { select: { name: true } },
        series: { select: { name: true } },
      },
    });
    if (!figureDetail) {
      problems.push("FIGURE_NOT_FOUND");
    } else {
      const riskType = String(item.riskType || "");
      if (riskType === "detail_missing_description") {
        const descLen = (figureDetail.description || "").length;
        if (descLen < 50) problems.push(`描述仅 ${descLen} 字符，仍不足`);
      }
      if (riskType === "detail_sparse_specs") {
        const specFields = [
          figureDetail.scale, figureDetail.material, figureDetail.priceJpy,
          figureDetail.releaseDate, figureDetail.heightMm, figureDetail.weightG,
          figureDetail.productLine, figureDetail.ageRating,
          figureDetail.manufacturer?.name, figureDetail.series?.name,
        ].filter(f => f != null);
        if (specFields.length < 3) problems.push(`有效规格字段仅 ${specFields.length} 项，仍不足`);
      }
      if (riskType === "detail_conflict") {
        problems.push("详细信息冲突，需人工判断");
      }
    }
  } else if (item.type === "jan_match" && figure) {
    const expectedJan = payload.janCode ? String(payload.janCode) : "";
    if (expectedJan && figure.janCode !== expectedJan) problems.push(`JAN 仍未更新为 ${expectedJan}`);
  } else if (item.type === "figure_import") {
    const slug = payload.figure?.slug || payload.slug || item.figureSlug;
    if (slug) {
      const existing = await app.prisma.figure.findFirst({ where: { slug: String(slug), isDeleted: false }, select: { id: true } });
      if (!existing) problems.push("候选手办仍未入库");
    } else {
      problems.push("候选内容缺少 slug，无法复检是否入库");
    }
  }

  return problems;
}


export async function adminApplyRoute(app: FastifyInstance) {
    app.post("/review/items/:id/apply", async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const existingRaw = await app.redis.get(`review:item:${id}`);
      if (!existingRaw) {
        return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
      }
  
      const item = JSON.parse(existingRaw);
      const payload = item.payload || {};
  
      try {
        let applied: any = null;
  
        if (item.type === "figure_import") {
          const figurePayload = payload.figure || {};
          if (!figurePayload.slug || !figurePayload.name) {
            return reply.status(422).send({ success: false, error: { code: "MISSING_FIGURE_PAYLOAD" } });
          }
  
          const { categoryIds, sculptorIds, characterIds, images, localized, releases, releaseDate, ...figureData } = figurePayload;
          const matchOr: any[] = [{ slug: figurePayload.slug }];
          if (figurePayload.janCode) matchOr.push({ janCode: figurePayload.janCode });
          const existingFigure = await app.prisma.figure.findFirst({
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
            ? await app.prisma.figure.update({
                where: { id: existingFigure.id },
                data: { ...figureData, ...relationData },
              })
            : await app.prisma.figure.create({
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
                const imageRecords = await processAndStoreImage(img.source, janCode, {
                  alt: img.alt,
                  sortOrder: img.sortOrder ?? i,
                });
                for (const rec of imageRecords) {
                  const result = await upsertFigureImageRecord(app, {
                    figureId: savedFigure.id,
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
                imageImport.errors.push({ source: img.source, error: err?.message || "Image processing failed" });
              }
            }
          }
  
          let revision: any = null;
          const rewrite = payload.rewrite || payload.rewriteDraft;
          if (rewrite?.contentMd) {
            const maxRev = await app.prisma.revision.aggregate({
              where: { figureId: savedFigure.id },
              _max: { versionNumber: true },
            });
            const nextVersion = (maxRev._max.versionNumber || 0) + 1;
            await app.prisma.revision.updateMany({ where: { figureId: savedFigure.id }, data: { isActive: false } });
            revision = await app.prisma.revision.create({
              data: {
                figureId: savedFigure.id,
                contentMd: rewrite.contentMd,
                summaryMd: rewrite.summaryMd || null,
                keyPoints: Array.isArray(rewrite.keyPoints) ? rewrite.keyPoints : [],
                relatedKeywords: Array.isArray(rewrite.relatedKeywords) ? rewrite.relatedKeywords : [],
                versionNumber: nextVersion,
                editSummary: rewrite.editSummary || "Created from figure import review",
                editorId: req.user?.userId ? BigInt(req.user.userId) : null,
                isActive: true,
                promptVersion: rewrite.promptVersion || item.automation?.workflow || null,
                qualityScore: typeof rewrite.qualityScore === "number" ? rewrite.qualityScore : null,
              },
            });
            await app.prisma.figure.update({ where: { id: savedFigure.id }, data: { activeRevisionId: revision.id } });
          }
  
          applied = {
            action: existingFigure ? "merged" : "created",
            figure: { id: Number(savedFigure.id), slug: savedFigure.slug },
            imageImport,
            revision: revision ? { id: Number(revision.id), versionNumber: revision.versionNumber } : null,
          };
        } else if (item.type === "jan_match") {
          const figureWhere = item.figureSlug
            ? { slug: item.figureSlug, isDeleted: false }
            : item.figureId
              ? { id: BigInt(item.figureId), isDeleted: false }
              : null;
          if (!figureWhere) {
            return reply.status(422).send({ success: false, error: { code: "MISSING_FIGURE_REF" } });
          }
          const figure = await app.prisma.figure.findFirst({ where: figureWhere as any });
          if (!figure) {
            return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });
          }
          if (!payload.janCode) {
            return reply.status(422).send({ success: false, error: { code: "MISSING_JAN_CODE" } });
          }
          applied = await app.prisma.figure.update({
            where: { id: figure.id },
            data: {
              janCode: payload.janCode,
            },
            select: { id: true, slug: true, janCode: true },
          });
        } else if (item.type === "rewrite") {
          const figureWhere = item.figureSlug
            ? { slug: item.figureSlug, isDeleted: false }
            : item.figureId
              ? { id: BigInt(item.figureId), isDeleted: false }
              : null;
          if (!figureWhere) {
            return reply.status(422).send({ success: false, error: { code: "MISSING_FIGURE_REF" } });
          }
          const figure = await app.prisma.figure.findFirst({ where: figureWhere as any });
          if (!figure) {
            return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });
          }
          if (!payload.contentMd) {
            return reply.status(422).send({ success: false, error: { code: "MISSING_CONTENT_MD" } });
          }
  
          const maxRev = await app.prisma.revision.aggregate({
            where: { figureId: figure.id },
            _max: { versionNumber: true },
          });
          const nextVersion = (maxRev._max.versionNumber || 0) + 1;
  
          applied = await app.prisma.$transaction(async (tx: any) => {
            await tx.revision.updateMany({ where: { figureId: figure.id }, data: { isActive: false } });
            const revision = await tx.revision.create({
              data: {
                figureId: figure.id,
                contentMd: payload.contentMd,
                summaryMd: payload.summaryMd || null,
                keyPoints: Array.isArray(payload.keyPoints) ? payload.keyPoints : [],
                relatedKeywords: Array.isArray(payload.relatedKeywords) ? payload.relatedKeywords : [],
                versionNumber: nextVersion,
                editSummary: payload.editSummary || "Applied from review queue",
                editorId: req.user?.userId ? BigInt(req.user.userId) : null,
                isActive: true,
                promptVersion: payload.promptVersion || item.automation?.workflow || null,
                qualityScore: typeof payload.qualityScore === "number" ? payload.qualityScore : null,
              },
            });
            await tx.figure.update({ where: { id: figure.id }, data: { activeRevisionId: revision.id } });
            return revision;
          });
        } else if (item.type === "image") {
          const figureWhere = item.figureSlug || payload.figureSlug
            ? { slug: item.figureSlug || payload.figureSlug, isDeleted: false }
            : item.figureId || payload.figureId
              ? { id: BigInt(item.figureId || payload.figureId), isDeleted: false }
              : null;
          if (!figureWhere) {
            return reply.status(422).send({ success: false, error: { code: "MISSING_FIGURE_REF" } });
          }
          const figure = await app.prisma.figure.findFirst({ where: figureWhere as any });
          if (!figure) {
            return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });
          }
  
          const images = Array.isArray(payload.images) ? payload.images : [];
          const processedImages = Array.isArray(payload.processedImages) ? payload.processedImages : [];
          if (images.length === 0 && processedImages.length === 0) {
            return reply.status(422).send({ success: false, error: { code: "MISSING_IMAGES" } });
          }
  
          const imageImport = { created: 0, errors: [] as Array<{ source: string; error: string }> };
          const janCode = payload.janCode || figure.janCode || "no-jancode";
          const createdSha256s: string[] = [];
  
          for (const processed of processedImages) {
            try {
              const stored = await storeProcessedReviewImage(app, figure.id, janCode, {
                ...processed,
                figureId: Number(figure.id),
                janCode,
              });
              if (!stored.updated) imageImport.created += 1;
              if (stored.sha256 && !createdSha256s.includes(stored.sha256)) createdSha256s.push(stored.sha256);
            } catch (err: any) {
              imageImport.errors.push({ source: processed?.source || "processed-image", error: err?.message || "Processed image import failed" });
            }
          }
  
          const processedSources = new Set(processedImages.map((img: any) => img?.source).filter(Boolean).map(String));
  
          for (let i = 0; i < images.length; i++) {
            const img = images[i] || {};
            const source = img.source || img.url;
            if (source && processedSources.has(String(source))) continue;
            if (!source) {
              imageImport.errors.push({ source: "", error: "Missing image source" });
              continue;
            }
            try {
              const imageRecords = await processAndStoreImage(source, img.janCode || janCode, {
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
              for (const rec of imageRecords) {
                if (rec.sha256 && !createdSha256s.includes(rec.sha256)) createdSha256s.push(rec.sha256);
              }
            } catch (err: any) {
              imageImport.errors.push({ source, error: err?.message || "Image processing failed" });
            }
          }
  
          if (imageImport.created === 0 && imageImport.errors.length > 0) {
            return reply.status(422).send({ success: false, error: { code: "IMAGE_IMPORT_FAILED", details: imageImport.errors } });
          }
  
          const deleteWhere: any[] = [];
          const deleteImageIds = Array.isArray(payload.deleteImageIds) ? payload.deleteImageIds : [];
          const deleteSha256s = Array.isArray(payload.deleteSha256s) ? payload.deleteSha256s : [];
          const deleteSources = Array.isArray(payload.deleteSources) ? payload.deleteSources : [];
          if (deleteImageIds.length) deleteWhere.push({ id: { in: deleteImageIds.map((imageId: any) => BigInt(imageId)) } });
          if (deleteSha256s.length) deleteWhere.push({ sha256: { in: deleteSha256s.map(String) } });
          if (deleteSources.length) deleteWhere.push({ source: { in: deleteSources.map(String) } });
  
          let deleted = 0;
          if (deleteWhere.length) {
            const result = await app.prisma.figureImage.deleteMany({
              where: {
                figureId: figure.id,
                OR: deleteWhere,
                NOT: createdSha256s.length ? { sha256: { in: createdSha256s } } : undefined,
              },
            });
            deleted = result.count;
          }
  
          applied = {
            action: "images_imported",
            figure: { id: Number(figure.id), slug: figure.slug },
            imageImport,
            deleted,
          };
        } else if (item.type === "image_review") {
          // P2: image_review apply — approve candidate image to figure_images
          const action = (req.body || {}).action || "approve_image";
          if (action !== "approve_image") {
            return reply.status(422).send({ success: false, error: { code: "UNSUPPORTED_ACTION", message: `image_review /apply only supports approve_image, got: ${action}` } });
          }
          const figureWhere = item.figureSlug
            ? { slug: item.figureSlug, isDeleted: false }
            : item.figureId
              ? { id: BigInt(item.figureId), isDeleted: false }
              : null;
          if (!figureWhere) {
            return reply.status(422).send({ success: false, error: { code: "MISSING_FIGURE_REF" } });
          }
          const figure = await app.prisma.figure.findFirst({ where: figureWhere as any });
          if (!figure) {
            return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });
          }
          // Require candidateImage
          const cand = item.candidateImage;
          if (!cand || !cand.source) {
            return reply.status(422).send({ success: false, error: { code: "MISSING_CANDIDATE_IMAGE", message: "No candidateImage to approve" } });
          }
          // Idempotent: check if source already in figure_images
          const existing = await app.prisma.figureImage.findFirst({
            where: { figureId: figure.id, source: cand.source },
            select: { id: true, source: true, sortOrder: true },
          });
          if (existing) {
            // Already approved — update data metadata to mark as reviewed
            await app.prisma.figureImage.update({
              where: { id: existing.id },
              data: {
                data: {
                  source_kind: "mfc_review_approved",
                  safe_display: true,
                  image_low_quality: false,
                  reviewed_by_admin: true,
                  review_item_id: id,
                },
                sortOrder: 0,  // Promote to front
              },
            });
            applied = { action: "already_approved", figure: { id: Number(figure.id), slug: figure.slug }, imageId: Number(existing.id), source: cand.source };
          } else {
            // Try to download and store image; fall back to URL redirect
            const janCode = figure.janCode || "no-jancode";
            let firstImageId: number | null = null;
            let processedCount = 0;
            let imageRecords: any[] = [];
  
            try {
              imageRecords = await processAndStoreImage(cand.source, janCode, {
                alt: undefined,
                sortOrder: 0,
                isNsfw: false,
              });
              processedCount = imageRecords.length;
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
                  data: {
                    source_kind: "mfc_review_approved",
                    safe_display: true,
                    image_low_quality: false,
                    reviewed_by_admin: true,
                    review_item_id: id,
                  },
                });
                if (result.created && firstImageId === null) {
                  firstImageId = Number(result.image.id);
                }
              }
            } catch {
              // Download failed (e.g. MFC Cloudflare block).
              // Create a "detail"-sized record using the source URL for browser redirect.
              // The theme prefers detail-size images for the gallery.
              const result = await upsertFigureImageRecord(app, {
                figureId: figure.id,
                janCode,
                sha256: null,
                size: "raw",
                format: "jpg",
                width: cand.width || null,
                height: cand.height || null,
                fileSize: null,
                alt: undefined,
                sortOrder: 0,
                source: cand.source,
                isNsfw: false,
                data: {
                  source_kind: "mfc_review_approved",
                  safe_display: true,
                  image_low_quality: false,
                  reviewed_by_admin: true,
                  review_item_id: id,
                },
              });
              firstImageId = Number(result.image.id);
              processedCount = 1;
            }
  
            applied = {
              action: "image_approved",
              figure: { id: Number(figure.id), slug: figure.slug },
              imageId: firstImageId,
              source: cand.source,
              processedCount,
            };
          }
        } else {
          return reply.status(422).send({ success: false, error: { code: "UNSUPPORTED_REVIEW_TYPE" } });
        }
  
        const now = new Date().toISOString();
        const problems = await evaluateReviewItem(app, item);
        const updatedItem = {
          ...item,
          payload: { ...(item.payload || {}), reviewProblems: problems, lastCheckedAt: now },
          status: problems.length === 0 ? "resolved" : "needs_changes",
          notes: problems.length === 0
            ? (item.notes ? `${item.notes}\nApplied and rechecked at ${now}` : `Applied and rechecked at ${now}`)
            : (item.notes ? `${item.notes}\nApplied but still needs changes: ${problems.join("; ")}` : `Applied but still needs changes: ${problems.join("; ")}`),
          updatedAt: now,
        };
        await app.redis.set(`review:item:${id}`, JSON.stringify(updatedItem));
        await scanKeys(app.redis, "figures:*");

        return { success: true, data: { item: updatedItem, applied, problems } };
      } catch (err: any) {
        return reply.status(422).send({
          success: false,
          error: { code: "REVIEW_APPLY_FAILED", message: err.message || "Failed to apply review item" },
        });
      }
    });
}

// Exported for use by apply-service.ts — executes the apply business logic for a given item
export async function executeApplyLogic(app: any, id: string): Promise<{ success: boolean; data?: any }> {
  const reply = { status: () => ({ send: () => {} }), send: (d: any) => d };
  const route = adminApplyRoute as (app: any) => Promise<void>;
  // Create a minimal request context
  const req: any = { params: { id }, body: {} };
  // The route handler is self-contained — we create a temporary Fastify registration
  // and invoke the handler directly
  const tempApp = {
    ...app,
    post: (path: string, handler: any) => {
      if (path === "/review/items/:id/apply") {
        // Execute handler with our mock objects
        return handler(req, {
          status: (code: number) => ({
            send: (data: any) => {
              if (code >= 400) throw Object.assign(new Error(data?.error?.message || "Apply failed"), { code, data });
              return data;
            },
          }),
          send: (data: any) => data,
        });
      }
    },
  };
  await adminApplyRoute(tempApp as any);
  return { success: true };
}
