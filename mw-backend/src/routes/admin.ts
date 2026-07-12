import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import sharp from "sharp";
import crypto from "crypto";
import { processAndStoreImage, upsertFigureImageRecord, downloadImage, validateImageUrl } from "./images.js";

const aigcSchema = z.object({
  figureId: z.number().int().positive(),
  locale: z.enum(["ja", "en", "zh"]).default("en"),
  promptVersion: z.string().optional(),
});

function legacyAdminImportsEnabled() {
  return process.env.ENABLE_LEGACY_ADMIN_IMPORTS === "true";
}

function legacyAdminImportsDisabled(reply: any) {
  return reply.status(410).send({
    success: false,
    error: {
      code: "LEGACY_IMPORT_DISABLED",
      message: "Legacy admin import endpoints are disabled",
    },
  });
}

const updateUserSchema = z.object({
  displayName: z.string().min(1).optional(),
  role: z.enum(["admin", "editor", "viewer"]).optional(),
  isActive: z.boolean().optional(),
});

const reviewStatusSchema = z.enum(["pending", "approved", "rejected", "needs_changes", "resolved", "stale"]);
const queryReviewStatusSchema = z.union([reviewStatusSchema, z.literal("all")]);
const reviewTypeSchema = z.enum(["jan_match", "figure_import", "rewrite", "image", "general", "image_review", "detail_review"]);
// Review risk types (Track RQ): unified vocabulary for crawler/agent uncertain content
const reviewRiskTypeSchema = z.enum([
  "image_suspicious_banner",
  "image_suspicious_thumbnail",
  "image_possible_user_photo",
  "image_possible_collection_or_room",
  "image_wrong_subject",
  "image_low_quality_fallback",
  "image_restore_candidate",
  "image_missing",
  "image_low_count",
  "detail_missing_description",
  "detail_sparse_specs",
  "detail_conflict",
  "category_uncertain",
  "general_risk",
]);
const reviewActionSchema = z.enum([
  "approve_image",
  "reject_image",
  "keep_placeholder",
  "mark_detail_ok",
  "request_refetch",
  "dismiss_stale",
  "keep_pending",
]);

const reviewItemSchema = z.object({
  type: reviewTypeSchema.default("general"),
  title: z.string().min(1),
  source: z.string().optional(),
  sourceId: z.string().optional(),
  status: reviewStatusSchema.default("pending"),
  priority: z.coerce.number().int().min(0).max(3).default(1),
  confidence: z.coerce.number().min(0).max(1).optional(),
  figureId: z.union([z.number().int(), z.string()]).optional(),
  figureSlug: z.string().optional(),
  // Track RQ: risk metadata for crawler/agent uncertain content
  riskType: reviewRiskTypeSchema.optional(),
  riskReason: z.string().max(1000).optional(),
  candidateImage: z.object({
    source: z.string(),
    imageId: z.union([z.number(), z.string()]).optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    fileSize: z.number().int().optional(),
    aspectRatio: z.number().optional(),
    url: z.string().optional(),
    cachedUrl: z.string().optional(),
  }).passthrough().optional(),
  currentPublicImage: z.object({
    imageId: z.union([z.number(), z.string()]).optional(),
    source: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
  }).optional(),
  detailSnapshot: z.object({
    description: z.string().optional(),
    specCount: z.number().int().optional(),
    specs: z.any().optional(),
    categories: z.array(z.any()).optional(),
  }).optional(),
  suggestedAction: reviewActionSchema.optional(),
  payload: z.any().optional(),
  notes: z.string().optional(),
  evidenceFingerprint: z.string().optional(),
  forceReopen: z.boolean().optional(),
  automation: z.object({
    provider: z.enum(["n8n", "hermes", "manual", "other"]).default("manual"),
    workflow: z.string().optional(),
    runId: z.string().optional(),
  }).optional(),
});

const candidateImageUpdateSchema = z.object({
  source: z.string(),
  imageId: z.union([z.number(), z.string()]).optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  fileSize: z.number().int().optional(),
  aspectRatio: z.number().optional(),
  url: z.string().optional(),
  cachedUrl: z.string().optional(),
}).passthrough().optional();

const reviewUpdateSchema = z.object({
  status: reviewStatusSchema.optional(),
  priority: z.coerce.number().int().min(0).max(3).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  payload: z.any().optional(),
  notes: z.string().max(2000).optional(),
  automation: z.object({
    provider: z.enum(["n8n", "hermes", "manual", "other"]).default("manual"),
    workflow: z.string().optional(),
    runId: z.string().optional(),
  }).optional(),
  candidateImage: candidateImageUpdateSchema,
  suggestedAction: reviewActionSchema.optional(),
  currentPublicImage: z.object({
    imageId: z.union([z.number(), z.string()]).optional(),
    source: z.string().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
  }).optional(),
});

const reviewQuerySchema = z.object({
  status: queryReviewStatusSchema.optional(),
  type: reviewTypeSchema.optional(),
  riskType: reviewRiskTypeSchema.optional(),
  suggestedAction: reviewActionSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Special sentinel: when status not provided, default to pending (don't show old items)
// Use "all" as explicit override to see everything
const ALL_STATUSES = "all";



// security-patched: 安全辅助函数
function safeBigInt(value: string): bigint | null {
  try {
    if (!/^-?\d+$/.test(value)) return null;
    return BigInt(value);
  } catch {
    return null;
  }
}

function isValidPassword(pwd: string): boolean {
  if (!pwd || typeof pwd !== "string") return false;
  if (pwd.length < 8 || pwd.length > 128) return false;
  if (!/[A-Z]/.test(pwd)) return false;
  if (!/[a-z]/.test(pwd)) return false;
  if (!/[^A-Za-z0-9]/.test(pwd)) return false;
  return true;
}

const ASSETS_PATH = process.env.ASSETS_PATH || "/app/assets";
const REVIEW_IMAGE_SIZES = new Set(["raw", "detail", "thumb"]);

function getReviewImageFilePath(janCode: string, sha256: string, size: string): string {
  return path.join(ASSETS_PATH, "figures", janCode, `${sha256}_${size}.webp`);
}

async function storeProcessedReviewImage(app: FastifyInstance, figureId: bigint, janCode: string, data: any) {
  const size = String(data.size || "");
  const sha256 = String(data.sha256 || "");
  if (!REVIEW_IMAGE_SIZES.has(size)) throw new Error(`Invalid processed image size: ${size}`);
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("Invalid processed image sha256");
  if (!data.contentBase64) throw new Error("Missing processed image contentBase64");

  const buffer = Buffer.from(String(data.contentBase64), "base64");
  if (!buffer.length) throw new Error("Processed image content is empty");

  const filePath = getReviewImageFilePath(janCode, sha256, size);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);

  const payload = {
    figureId,
    janCode,
    sha256,
    size,
    format: data.format || "webp",
    width: data.width ?? null,
    height: data.height ?? null,
    fileSize: data.fileSize || buffer.length,
    alt: data.alt || null,
    sortOrder: data.sortOrder ?? 0,
    source: data.source || null,
    isNsfw: data.isNsfw || false,
  };

  const { image, created } = await upsertFigureImageRecord(app, payload);

  return { image, sha256, updated: !created };
}
async function resolveReviewFigure(app: FastifyInstance, item: any, payload: any) {
  const slug = item.figureSlug || payload.figureSlug || payload.slug || payload.figure?.slug;
  const id = item.figureId || payload.figureId || payload.figure?.id;
  if (slug) return app.prisma.figure.findFirst({ where: { slug: String(slug), isDeleted: false }, select: { id: true, slug: true, name: true, janCode: true, activeRevisionId: true } });
  if (id) return app.prisma.figure.findFirst({ where: { id: BigInt(id), isDeleted: false }, select: { id: true, slug: true, name: true, janCode: true, activeRevisionId: true } });
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
const crawlerRunnerSchema = z.enum(["server_safe", "local_browser", "proxy_browser", "manual"]);
const crawlerJobStatusSchema = z.enum(["queued", "claimed", "running", "succeeded", "failed", "deferred", "cancelled"]);

const crawlerJobSchema = z.object({
  source: z.string().min(1),
  task: z.string().min(1),
  runner: crawlerRunnerSchema.default("server_safe"),
  status: crawlerJobStatusSchema.default("queued"),
  priority: z.coerce.number().int().min(0).max(3).default(1),
  payload: z.any().optional(),
  notBefore: z.string().datetime().optional(),
  maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
  notes: z.string().optional(),
  automation: z.object({
    provider: z.enum(["n8n", "hermes", "manual", "other"]).default("manual"),
    workflow: z.string().optional(),
    runId: z.string().optional(),
  }).optional(),
});

const crawlerJobUpdateSchema = z.object({
  status: crawlerJobStatusSchema.optional(),
  runner: crawlerRunnerSchema.optional(),
  priority: z.coerce.number().int().min(0).max(3).optional(),
  payload: z.any().optional(),
  result: z.any().optional(),
  resultSummary: z.any().optional(),
  error: z.string().optional(),
  notes: z.string().optional(),
  notBefore: z.string().datetime().nullable().optional(),
});

const crawlerJobQuerySchema = z.object({
  status: crawlerJobStatusSchema.optional(),
  runner: crawlerRunnerSchema.optional(),
  source: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const crawlerClaimSchema = z.object({
  runner: crawlerRunnerSchema,
  workerId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(10).default(1),
});

export async function adminRoutes(app: FastifyInstance) {
  app.post("/aigc/generate", async (req: any, reply: any) => {
    const data = aigcSchema.parse(req.body);

    const figure = await app.prisma.figure.findUnique({ where: { id: data.figureId } });
    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND", message: "Figure not found" } });

    await app.redis.lpush("aigc:queue", JSON.stringify({
      figureId: data.figureId,
      figureSlug: figure.slug,
      locale: data.locale,
      promptVersion: data.promptVersion || "v1",
      createdAt: new Date().toISOString(),
    }));

    return { success: true, data: { figureId: data.figureId, status: "queued", locale: data.locale } };
  });

  app.get("/aigc/status/:figureId", async (req: any) => {
    const { figureId } = req.params as { figureId: string };
    const id = parseInt(figureId, 10);
    if (isNaN(id)) return { success: true, data: { status: "invalid_id" } };

    const result = await app.redis.get(`aigc:result:${id}`);
    if (result) return { success: true, data: { status: "completed", result: JSON.parse(result) } };

    const queue = await app.redis.lrange("aigc:queue", 0, -1);
    const inQueue = queue.some((item: string) => {
      try { return JSON.parse(item).figureId === id; } catch { return false; }
    });

    return { success: true, data: { status: inQueue ? "queued" : "not_found" } };
  });

  app.get("/review/items", async (req: any) => {
    const query = reviewQuerySchema.parse(req.query || {});
    // Default to pending when status not provided (P0 fix: don't show old items by default)
    const statusFilter = query.status || "pending";
    const showAll = statusFilter === ALL_STATUSES;
    const ids = await app.redis.zrevrange("review:items", 0, -1);
    const filtered: any[] = [];

    for (const id of ids) {
      const raw = await app.redis.get(`review:item:${id}`);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        if (!showAll && item.status !== statusFilter) continue;
        if (query.type && item.type !== query.type) continue;
        if (query.riskType && item.riskType !== query.riskType) continue;
        if (query.suggestedAction && item.suggestedAction !== query.suggestedAction) continue;
        filtered.push(item);
      } catch {}
    }

    const total = filtered.length;
    const offset = query.offset || 0;
    const items = filtered.slice(offset, offset + query.limit);

    // Enrich items with current figure state (batch, no N+1)
    const slugSet = new Set<string>();
    const idSet = new Set<bigint>();
    for (const item of items) {
      if (item.figureSlug) slugSet.add(item.figureSlug);
      if (item.figureId) idSet.add(BigInt(item.figureId));
    }
    const figures: any[] = [];
    if (idSet.size > 0) {
      const byId = await app.prisma.figure.findMany({
        where: { id: { in: [...idSet] }, isDeleted: false },
        select: {
          id: true, slug: true, name: true, description: true,
          scale: true, material: true, priceJpy: true, releaseDate: true, heightMm: true,
          manufacturer: { select: { name: true } },
          series: { select: { name: true } },
          images: { take: 5, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, width: true, height: true, data: true } },
        },
      });
      figures.push(...byId);
    }
    if (slugSet.size > 0) {
      const bySlug = await app.prisma.figure.findMany({
        where: { slug: { in: [...slugSet] }, isDeleted: false },
        select: {
          id: true, slug: true, name: true, description: true,
          scale: true, material: true, priceJpy: true, releaseDate: true, heightMm: true,
          manufacturer: { select: { name: true } },
          series: { select: { name: true } },
          images: { take: 5, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, width: true, height: true, data: true } },
        },
      });
      for (const fig of bySlug) {
        if (!figures.some(f => f.id === fig.id)) figures.push(fig);
      }
    }
    const figureMap = new Map<string, any>();
    for (const fig of figures) {
      figureMap.set(fig.slug, fig);
      figureMap.set(String(fig.id), fig);
    }

    for (const item of items) {
      const fig = figureMap.get(item.figureSlug) || figureMap.get(String(item.figureId));
      if (fig) {
        const primaryImage = (fig.images || []).length > 0 ? (fig.images[0] || null) : null;
        const primaryMeta = primaryImage?.data || {};
        const specFields = [fig.scale, fig.material, fig.priceJpy, fig.releaseDate, fig.heightMm, fig.manufacturer?.name, fig.series?.name].filter((f: any) => f != null);
        item.currentFigure = {
          id: Number(fig.id),
          title: fig.name || "",
          slug: fig.slug,
          imageCount: fig.images?.length || 0,
          primaryImage: primaryImage ? {
            imageId: Number(primaryImage.id),
            sourceKind: String(primaryMeta.source_kind || ""),
            width: primaryImage.width,
            height: primaryImage.height,
            apiUrl: primaryImage ? `/api/v1/figures/images/${primaryImage.id}` : null,
          } : null,
          detail: {
            descriptionLength: (fig.description || "").length,
            descriptionSnapshot: (fig.description || "").slice(0, 200),
            validSpecCount: specFields.length,
            missingFields: [],
          },
        };
      }
    }

    return { success: true, data: items, meta: { count: items.length, total, limit: query.limit, offset, defaultStatus: statusFilter } };
  });

  // GET /review/stats: statistics for the review queue (P0 fix: stats bar)
  app.get("/review/stats", async () => {
    const ids = await app.redis.zrevrange("review:items", 0, -1);
    const stats = {
      total: 0,
      pending: 0,
      pending_image_review: 0,
      pending_detail_review: 0,
      pending_rewrite: 0,
      pending_figure_import: 0,
      stale: 0,
      resolved: 0,
      rejected: 0,
      approved: 0,
      needs_changes: 0,
      archived: 0,
    };
    for (const id of ids) {
      const raw = await app.redis.get(`review:item:${id}`);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        stats.total += 1;
        const s = item.status || "unknown";
        if (s === "pending") {
          stats.pending += 1;
          const t = item.type || "";
          if (t === "image_review") stats.pending_image_review += 1;
          else if (t === "detail_review") stats.pending_detail_review += 1;
          else if (t === "rewrite") stats.pending_rewrite += 1;
          else if (t === "figure_import") stats.pending_figure_import += 1;
        } else if (s === "stale") {
          stats.stale += 1;
        } else if (s === "resolved") {
          stats.resolved += 1;
        } else if (s === "rejected") {
          stats.rejected += 1;
        } else if (s === "approved") {
          stats.approved += 1;
        } else if (s === "needs_changes") {
          stats.needs_changes += 1;
        }
      } catch {}
    }
    // Archived count
    stats.archived = await app.redis.zcard("review:archive");
    return { success: true, data: stats };
  });

  app.post("/review/items", async (req: any, reply: any) => {
    const data = reviewItemSchema.parse(req.body);
    const now = new Date().toISOString();
    
    // Generate evidenceFingerprint if not provided
    let fingerprint = data.evidenceFingerprint;
    if (!fingerprint) {
      const parts = [data.type, data.figureId || data.figureSlug || "no-fig"];
      if (data.type === "image_review" || data.type === "image") {
        parts.push(data.riskType || "no-risk");
        parts.push(data.candidateImage?.url || data.candidateImage?.source || "no-image");
      } else if (data.type === "detail_review") {
        parts.push(data.riskType || "no-risk");
        parts.push(data.detailSnapshot?.description || "no-desc");
      } else if (data.type === "jan_match") {
        parts.push(data.payload?.janCode || "no-jan");
      } else if (data.type === "figure_import") {
        parts.push(data.payload?.sourceUrl || "no-url");
      } else {
        parts.push(data.title);
      }
      fingerprint = crypto.createHash("sha256").update(parts.join("|")).digest("hex");
    }

    // Duplicate suppression (Phase 2)
    if (!data.forceReopen && fingerprint) {
      const existingId = await app.redis.get(`review:fingerprint:${fingerprint}`);
      if (existingId) {
        const existingRaw = await app.redis.get(`review:item:${existingId}`);
        if (existingRaw) {
          try {
            const existing = JSON.parse(existingRaw);
            // Ignore if it's the exact same fingerprint.
            // If it's still pending, it just stays pending. If it was resolved, we don't reopen it.
            // Just return success:true and suppressed:true
            return reply.status(200).send({ success: true, data: existing, suppressed: true, reason: "Duplicate evidenceFingerprint" });
          } catch {}
        }
      }
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item = {
      id,
      ...data,
      evidenceFingerprint: fingerprint,
      createdAt: now,
      updatedAt: now,
    };

    await app.redis.set(`review:item:${id}`, JSON.stringify(item));
    await app.redis.zadd("review:items", Date.now(), id);
    if (fingerprint) {
      await app.redis.set(`review:fingerprint:${fingerprint}`, id);
    }
    
    return reply.status(201).send({ success: true, data: item });
  });

  app.put("/review/items/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const existingRaw = await app.redis.get(`review:item:${id}`);
    if (!existingRaw) {
      return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
    }

    const update = reviewUpdateSchema.parse(req.body);
    const existing = JSON.parse(existingRaw);
    const item = {
      ...existing,
      ...update,
      updatedAt: new Date().toISOString(),
    };

    await app.redis.set(`review:item:${id}`, JSON.stringify(item));
    return { success: true, data: item };
  });

  app.post("/review/items/:id/recheck", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const existingRaw = await app.redis.get(`review:item:${id}`);
    if (!existingRaw) {
      return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
    }

    const item = JSON.parse(existingRaw);
    const now = new Date().toISOString();
    const problems = await evaluateReviewItem(app, item);
    const nextPayload = {
      ...(item.payload || {}),
      reviewProblems: problems,
      lastCheckedAt: now,
    };
    const hasDeterministicProblem = problems.length > 0 && !problems.some(p => p.includes("需人工判断"));
    const newStatus = problems.length === 0 ? "resolved" : hasDeterministicProblem ? "needs_changes" : item.status;
    const noteText = problems.length === 0
      ? `复检通过：${now}`
      : `复检仍有问题：${problems.join("；")}`;
    const updatedItem = {
      ...item,
      payload: nextPayload,
      status: newStatus,
      notes: item.notes ? `${item.notes}\n${noteText}` : noteText,
      updatedAt: now,
    };

    await app.redis.set(`review:item:${id}`, JSON.stringify(updatedItem));
    return { success: true, data: { item: updatedItem, problems } };
  });
  // Track RQ: unified action endpoint for review queue (image/detail actions)
  app.post("/review/items/:id/action", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const actionBody = z.object({
      action: reviewActionSchema,
      notes: z.string().optional(),
    }).parse(req.body || {});
    const existingRaw = await app.redis.get(`review:item:${id}`);
    if (!existingRaw) {
      return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
    }
    const item = JSON.parse(existingRaw);
    const now = new Date().toISOString();
    // Map action -> resulting status + behavior
    const actionStatusMap: Record<string, string> = {
      approve_image: "approved",
      reject_image: "rejected",
      keep_placeholder: "resolved",
      mark_detail_ok: "resolved",
      request_refetch: "needs_changes",
      dismiss_stale: "resolved",
      keep_pending: "pending",
    };
    const newStatus = actionStatusMap[actionBody.action] || item.status;
    const actionNoteMap: Record<string, string> = {
      approve_image: "管理员批准候选图",
      reject_image: "管理员拒绝候选图",
      keep_placeholder: "保留当前占位图",
      mark_detail_ok: "管理员确认详情无误",
      request_refetch: "请求爬虫重新抓取",
      dismiss_stale: "标记过期项已处理",
      keep_pending: "人工无法判断，保留待审",
    };
    const reviewer = (req as any).user?.displayName || String((req as any).user?.userId || "");
    const notePrefix = reviewer ? "[" + reviewer + "] " : "";
    const note = notePrefix + (actionNoteMap[actionBody.action] || actionBody.action);
    const userNote = actionBody.notes ? `（${actionBody.notes}）` : "";
    const updatedItem = {
      ...item,
      status: newStatus,
      notes: item.notes ? `${item.notes}
[${now}] ${note}${userNote}` : `[${now}] ${note}${userNote}`,
      payload: { ...(item.payload || {}), lastAction: actionBody.action, lastActionAt: now, decisionReason: actionBody.notes || null },
      updatedAt: now,
    };
    await app.redis.set(`review:item:${id}`, JSON.stringify(updatedItem));

    // P0: request_refetch creates a crawler job with correct source detection
    let crawlerJobId: string | null = null;
    if (actionBody.action === "request_refetch") {
      // Idempotency: check existing crawlerJobId in payload
      const existingJobId = (updatedItem.payload || {}).crawlerJobId;
      if (existingJobId) {
        const existingRaw = await app.redis.get(`crawler:job:${existingJobId}`);
        if (existingRaw) {
          try {
            const existingJob = JSON.parse(existingRaw);
            if (["queued", "claimed", "running", "deferred"].includes(existingJob.status)) {
              crawlerJobId = existingJobId;  // reuse
            }
          } catch {}
        }
      }
      if (!crawlerJobId) {
        // P0: Determine correct crawler source based on available identifiers
        const fid = item.figureId ? Number(item.figureId) : null;
        const figSlug = item.figureSlug || (item.payload || {}).figureSlug || "";
        const snap = (item.payload || {}).detailSnapshot || {};
        const itemSource = String(item.source || "").toLowerCase();
        const rawSourceId = String(item.sourceId || "");
        const rawMfcId = String(snap.mfc_id || snap.mfcId || (item.payload || {}).mfcId || "");
        const rawJanCode = String(snap.jan_code || snap.janCode || (item.payload || {}).janCode || "");
        const rawHobbySearchId = String(snap.hobbysearch_id || snap.hobbySearchId || snap.hobby_search_id || (item.payload || {}).hobbySearchId || "");

        // JAN pattern: 8 or 13 digits
        const isJan = (s: string) => /^\d{8}$/.test(s) || /^\d{13}$/.test(s);
        // MFC item id: typically 1-8 digit numeric (NOT 13-digit JAN)
        const isMfcItemId = (s: string) => /^\d{1,8}$/.test(s);

        let jobSource: string;
        let jobRunner: string = "local_browser";
        let jobNotes: string | undefined;
        const jobPayload: any = {
          figureId: fid,
          figureSlug: figSlug,
          reason: item.riskReason || `Refetch from review item ${id}`,
          reviewItemId: id,
          needImages: item.type !== "detail_review",
          needDetails: item.type === "detail_review",
        };

        if (rawMfcId && isMfcItemId(rawMfcId)) {
          // 1. Explicit MFC item id from detailSnapshot
          jobSource = "mfc";
          jobPayload.mfcId = rawMfcId;
        } else if (itemSource.includes("mfc") && rawSourceId && isMfcItemId(rawSourceId)) {
          // 1b. Source is MFC and sourceId looks like a short MFC item id
          jobSource = "mfc";
          jobPayload.mfcId = rawSourceId;
        } else if (rawJanCode && isJan(rawJanCode)) {
          // 2. JAN code from detailSnapshot
          jobSource = "amiami";
          jobPayload.janCode = rawJanCode;
        } else if (isJan(rawSourceId)) {
          // 2b. sourceId is a JAN code (8 or 13 digits)
          jobSource = "amiami";
          jobPayload.janCode = rawSourceId;
        } else if (rawHobbySearchId) {
          // 3. HobbySearch ID
          jobSource = "hobbysearch";
          jobPayload.hobbySearchId = rawHobbySearchId;
        } else {
          // 4. Unknown source — manual job
          jobSource = "manual";
          jobRunner = "manual";
          jobNotes = `无法自动判断来源: source=${item.source || ""}, sourceId=${rawSourceId}, mfcId=${rawMfcId}, janCode=${rawJanCode}`;
          jobPayload.unresolvedSource = true;
        }

        const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const job = {
          id: jobId,
          attempts: 0,
          source: jobSource,
          task: "fetch_item",
          runner: jobRunner,
          status: "queued",
          priority: 2,
          payload: jobPayload,
          notes: jobNotes,
          notBefore: new Date().toISOString(),
          maxAttempts: 3,
          automation: { provider: "manual" as const, workflow: "review-refetch" },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const score = Date.now() + 2 * 1_000_000_000;
        await app.redis.set(`crawler:job:${jobId}`, JSON.stringify(job));
        await app.redis.zadd("crawler:jobs", score, jobId);
        crawlerJobId = jobId;
        // Record crawlerJobId in item payload + notes for unresolved source
        updatedItem.payload = { ...(updatedItem.payload || {}), crawlerJobId, crawlerSource: jobSource };
        if (jobNotes) {
          updatedItem.notes = updatedItem.notes
            ? `${updatedItem.notes}\n[${new Date().toISOString()}] ${jobNotes}`
            : `[${new Date().toISOString()}] ${jobNotes}`;
        }
        await app.redis.set(`review:item:${id}`, JSON.stringify(updatedItem));
      }
    }

    // Purge figure display caches when image decisions are made (no FLUSHDB)
    if (["approve_image", "reject_image", "keep_placeholder"].includes(actionBody.action) && item.figureSlug) {
      const figKeys = await app.redis.keys(`figures:detail:*`);
      if (figKeys.length > 0) await app.redis.del(...figKeys);
    }
    return { success: true, data: { item: updatedItem, action: actionBody.action, crawlerJobId } };
  });

  // Track RQ: bulk cleanup - mark old resolved rewrite items as stale
  app.post("/review/items/bulk/cleanup", async (req: any, reply: any) => {
    const body = z.object({
      dryRun: z.boolean().default(false),
      markStale: z.boolean().default(true),
      olderThanDays: z.coerce.number().int().min(1).default(1),
    }).parse(req.body || {});
    const cutoff = Date.now() - body.olderThanDays * 86400000;
    const ids = await app.redis.zrevrange("review:items", 0, -1);
    const updated: string[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const raw = await app.redis.get(`review:item:${id}`);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        // Only touch already-resolved rewrite items from localized-description-sync
        if (item.type !== "rewrite" || item.source !== "localized-description-sync") {
          skipped.push(id);
          continue;
        }
        if (item.status !== "resolved" && item.status !== "stale") {
          skipped.push(id);
          continue;
        }
        const ts = Date.parse(item.updatedAt || item.createdAt || "");
        if (isNaN(ts) || ts > cutoff) {
          skipped.push(id);
          continue;
        }
        if (body.dryRun) { updated.push(id); continue; }
        if (body.markStale && item.status !== "stale") {
          const now = new Date().toISOString();
          const updatedItem = {
            ...item,
            status: "stale" as const,
            notes: item.notes ? `${item.notes}
[${now}] 自动清理：已 resolved 的旧 rewrite 项标记为 stale` : `[${now}] 自动清理：已 resolved 的旧 rewrite 项标记为 stale`,
            updatedAt: now,
          };
          await app.redis.set(`review:item:${id}`, JSON.stringify(updatedItem));
        }
        updated.push(id);
      } catch {}
    }
    return {
      success: true,
      data: {
        updatedCount: updated.length,
        skippedCount: skipped.length,
        totalScanned: ids.length,
        dryRun: body.dryRun,
        sampleUpdated: updated.slice(0, 5),
      },
    };
  });

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
      const allKeys = await app.redis.keys("figures:*");
      if (allKeys.length > 0) await app.redis.del(...allKeys);

      return { success: true, data: { item: updatedItem, applied, problems } };
    } catch (err: any) {
      return reply.status(422).send({
        success: false,
        error: { code: "REVIEW_APPLY_FAILED", message: err.message || "Failed to apply review item" },
      });
    }
  });

  app.get("/crawler/jobs", async (req: any) => {
    const query = crawlerJobQuerySchema.parse(req.query || {});
    const ids = await app.redis.zrevrange("crawler:jobs", 0, Math.max(query.limit * 5, query.limit) - 1);
    const jobs: any[] = [];

    for (const id of ids) {
      const raw = await app.redis.get(`crawler:job:${id}`);
      if (!raw) continue;
      try {
        const job = JSON.parse(raw);
        if (query.status && job.status !== query.status) continue;
        if (query.runner && job.runner !== query.runner) continue;
        if (query.source && job.source !== query.source) continue;
        jobs.push(job);
        if (jobs.length >= query.limit) break;
      } catch {}
    }

    return { success: true, data: jobs, meta: { count: jobs.length, limit: query.limit } };
  });

  app.post("/crawler/jobs", async (req: any, reply: any) => {
    const data = crawlerJobSchema.parse(req.body);
    const now = new Date().toISOString();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id,
      attempts: 0,
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    const score = Date.now() + data.priority * 1_000_000_000;
    await app.redis.set(`crawler:job:${id}`, JSON.stringify(job));
    await app.redis.zadd("crawler:jobs", score, id);
    return reply.status(201).send({ success: true, data: job });
  });

  app.post("/crawler/jobs/claim", async (req: any) => {
    const data = crawlerClaimSchema.parse(req.body);
    const ids = await app.redis.zrevrange("crawler:jobs", 0, 500);
    const claimed: any[] = [];
    const nowMs = Date.now();

    for (const id of ids) {
      if (claimed.length >= data.limit) break;
      const raw = await app.redis.get(`crawler:job:${id}`);
      if (!raw) continue;
      let job: any;
      try { job = JSON.parse(raw); } catch { continue; }
      if (job.status !== "queued" && job.status !== "deferred") continue;
      if (job.runner !== data.runner) continue;
      if (job.notBefore && Date.parse(job.notBefore) > nowMs) continue;
      if ((job.attempts || 0) >= (job.maxAttempts || 3)) continue;

      const updated = {
        ...job,
        status: "claimed",
        attempts: (job.attempts || 0) + 1,
        workerId: data.workerId,
        claimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await app.redis.set(`crawler:job:${id}`, JSON.stringify(updated));
      claimed.push(updated);
    }

    return { success: true, data: claimed, meta: { count: claimed.length } };
  });

  app.get("/crawler/jobs/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const raw = await app.redis.get(`crawler:job:${id}`);
    if (!raw) {
      return reply.status(404).send({ success: false, error: { code: "CRAWLER_JOB_NOT_FOUND", message: "Crawler job not found" } });
    }
    try {
      const job = JSON.parse(raw);
      return { success: true, data: job };
    } catch {
      return reply.status(500).send({ success: false, error: { code: "CRAWLER_JOB_PARSE_ERROR", message: "Failed to parse job JSON" } });
    }
  });

  app.put("/crawler/jobs/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const existingRaw = await app.redis.get(`crawler:job:${id}`);
    if (!existingRaw) {
      return reply.status(404).send({ success: false, error: { code: "CRAWLER_JOB_NOT_FOUND" } });
    }

    const update = crawlerJobUpdateSchema.parse(req.body);
    const existing = JSON.parse(existingRaw);
    const job = {
      ...existing,
      ...update,
      updatedAt: new Date().toISOString(),
    };

    await app.redis.set(`crawler:job:${id}`, JSON.stringify(job));
    return { success: true, data: job };
  });

  // Allowed cache namespaces for purge (no review/crawler/session/rate-limit)
  const CACHE_ALLOWLIST = [
    "figures:detail:*",
    "figures:list:*",
    "search:*",
    "homepage:*",
  ];
  const BLOCKED_NAMESPACES = ["review:", "crawler:", "session:", "rate-limit:"];

  function isAllowedPattern(p: string): boolean {
    if (!p || typeof p !== "string") return false;
    for (const blocked of BLOCKED_NAMESPACES) {
      if (p.startsWith(blocked) || p.includes(blocked)) return false;
    }
    for (const allowed of CACHE_ALLOWLIST) {
      const re = new RegExp("^" + allowed.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
      if (re.test(p)) return true;
    }
    return false;
  }

  app.post("/cache/purge", async (req: any, reply: any) => {
    const body = (req.body as any) || {};
    const pattern = typeof body.pattern === "string" ? body.pattern : undefined;
    const paths = Array.isArray(body.paths) ? body.paths.filter((p: unknown): p is string => typeof p === "string" && p.length > 0) : [];

    // Block FLUSHDB / purgeAll
    if (body.purgeAll === true || (!pattern && paths.length === 0) || pattern === "*") {
      return reply.status(422).send({ success: false, error: { code: "PURGE_ALL_BLOCKED", message: "Full flush is not allowed. Use specific namespace patterns." } });
    }

    const namespaces: string[] = [];
    const keySet = new Set<string>();

    if (pattern) {
      if (!isAllowedPattern(pattern)) {
        return reply.status(422).send({ success: false, error: { code: "NAMESPACE_NOT_ALLOWED", message: `Pattern "${pattern}" is not in the allowed cache namespace list` } });
      }
      namespaces.push(pattern);
      // Use SCAN instead of KEYS
      let cursor = "0";
      do {
        const result = await (app.redis as any).scan(cursor, "MATCH", pattern, "COUNT", "100");
        cursor = result[0];
        for (const k of result[1]) keySet.add(k);
      } while (cursor !== "0");
    }

    for (const path of paths) {
      const m = path.match(/^\/figures?\/([^/]+)\/?$/);
      if (m?.[1]) {
        const detailKey = `figures:detail:${m[1]}`;
        keySet.add(detailKey);
        namespaces.push(detailKey);
      }
    }

    if (paths.length > 0) {
      namespaces.push("figures:list:*");
      let cursor2 = "0";
      do {
        const result2 = await (app.redis as any).scan(cursor2, "MATCH", "figures:list:*", "COUNT", "100");
        cursor2 = result2[0];
        for (const k of result2[1]) keySet.add(k);
      } while (cursor2 !== "0");
    }

    const keys = Array.from(keySet);
    let deleted = 0;
    if (keys.length > 0) {
      deleted = await app.redis.unlink(...keys);
    }

    return { success: true, data: { purged: true, mode: "targeted", matched: keys.length, deleted, namespaces } };
  });

  app.get("/stats", async () => {
    const [figures, manufacturers, series, sculptors, categories, characters, users, images] = await Promise.all([
      app.prisma.figure.count({ where: { isDeleted: false } }),
      app.prisma.manufacturer.count(),
      app.prisma.series.count(),
      app.prisma.sculptor.count(),
      app.prisma.category.count(),
      app.prisma.character.count(),
      app.prisma.user.count(),
      app.prisma.figureImage.count(),
    ]);

    const [recentFigures, upcomingReleases, topManufacturers] = await Promise.all([
      app.prisma.figure.findMany({
        where: { isDeleted: false },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, slug: true, name: true, nameEn: true, createdAt: true },
      }),
      app.prisma.figure.findMany({
        where: { isDeleted: false, releaseDate: { gte: new Date() } },
        orderBy: { releaseDate: "asc" },
        take: 5,
        select: { id: true, slug: true, name: true, nameEn: true, releaseDate: true, priceJpy: true },
      }),
      app.prisma.manufacturer.findMany({
        orderBy: { figures: { _count: "desc" } },
        take: 10,
        select: { id: true, slug: true, name: true, _count: { select: { figures: true } } },
      }),
    ]);

    return {
      success: true,
      data: {
        counts: { figures, manufacturers, series, sculptors, categories, characters, users, images },
        recentFigures,
        upcomingReleases,
        topManufacturers,
      },
    };
  });

  app.get("/users", async () => {
    const prisma = app.prisma as any;
    const users = await prisma.user.findMany({
      select: { id: true, displayName: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    return { success: true, data: users };
  });

  app.put("/users/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = safeBigInt(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });
    // 安全：防止admin自我降级，防止降级最后一个admin
    const data = updateUserSchema.parse(req.body);
    const existing = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "USER_NOT_FOUND" } });
    if (data.role && data.role !== "admin" && existing.role === "admin") {
      // 计算当前剩余admin数
      const adminCount = await app.prisma.user.count({ where: { role: "admin", isActive: true } });
      if (adminCount <= 1) {
        return reply.status(400).send({ success: false, error: { code: "LAST_ADMIN", message: "Cannot demote the last admin" } });
      }
    }

    const user = await (app.prisma as any).user.update({
      where: { id: userId },
      data,
      select: { id: true, displayName: true, role: true, isActive: true, createdAt: true },
    });
    return { success: true, data: user };
  });

  app.put("/users/:id/password", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = safeBigInt(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });

    const schema = z.object({ newPassword: z.string().min(1) });
    const { newPassword } = schema.parse(req.body);
    // 安全：后端复用密码强度规则
    if (!isValidPassword(newPassword)) {
      return reply.status(422).send({ success: false, error: { code: "WEAK_PASSWORD", message: "密码需至少8位且包含大小写字母和特殊字符" } });
    }

    const existing = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "USER_NOT_FOUND" } });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await app.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return { success: true, data: { message: "密码已重置" } };
  });

  app.post("/users", async (req: any, reply: any) => {
    const schema = z.object({
      username: z.string().min(1),
      password: z.string().min(1),
      role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
    });
    const data = schema.parse(req.body);
    // 安全：后端密码强度校验
    if (!isValidPassword(data.password)) {
      return reply.status(422).send({ success: false, error: { code: "WEAK_PASSWORD", message: "密码需至少8位且包含大小写字母和特殊字符" } });
    }

    const existing = await app.prisma.user.findFirst({ where: { displayName: data.username } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "USERNAME_EXISTS", message: "用户名已被使用" } });

    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await (app.prisma as any).user.create({
      data: { displayName: data.username, passwordHash, role: data.role, isActive: true },
      select: { id: true, displayName: true, role: true, isActive: true, createdAt: true },
    });
    return reply.status(201).send({ success: true, data: user });
  });

  app.delete("/users/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = safeBigInt(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });

    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(404).send({ success: false, error: { code: "USER_NOT_FOUND", message: "用户不存在" } });
    // 安全：防止删除最后一个admin
    if (user.role === "admin") {
      const adminCount = await app.prisma.user.count({ where: { role: "admin", isActive: true } });
      if (adminCount <= 1) {
        return reply.status(400).send({ success: false, error: { code: "LAST_ADMIN", message: "Cannot delete the last admin" } });
      }
    }

    await app.prisma.$transaction([
      app.prisma.favoriteGroup.deleteMany({ where: { userId } }),
      app.prisma.favorite.deleteMany({ where: { userId } }),
      app.prisma.user.delete({ where: { id: userId } }),
    ]);

    return { success: true, data: { message: "用户已删除" } };
  });

  app.get("/import/status", async (_req: any, reply: any) => {
    if (!legacyAdminImportsEnabled()) return legacyAdminImportsDisabled(reply);

    const queueLen = await app.redis.llen("legacy:import:queue");
    const processing = await app.redis.get("legacy:import:processing");
    const recentImports: Array<{ itemId: number; status: string }> = [];

    const recentKeys = await app.redis.keys("legacy:import:result:*");
    for (const key of recentKeys.slice(-10)) {
      const val = await app.redis.get(key);
      if (val) {
        try { recentImports.push(JSON.parse(val)); } catch {}
      }
    }

    return {
      success: true,
      data: {
        queueLength: queueLen,
        isProcessing: !!processing,
        currentJob: processing ? JSON.parse(processing) : null,
        recentImports,
      },
    };
  });

  // Admin-only review image proxy with SSRF protection
  app.get("/review/image-proxy", { config: { rateLimit: { max: 100, timeWindow: "1 minute" } } }, async (req: any, reply: any) => {
    // Auth check
    if (!req.user || !req.user.role) {
      return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED", message: "Admin auth required" } });
    }

    const { url } = z.object({ url: z.string() }).parse(req.query);

    // SSRF protection
    const urlCheck = await validateImageUrl(url);
    if (!urlCheck.ok) {
      return reply.status(422).send({ success: false, error: { code: "URL_BLOCKED", message: urlCheck.reason || "URL not allowed" } });
    }

    try {
      const result = await downloadImage(url);
      const ct = (result.contentType || "image/jpeg").toLowerCase();
      if (!ct.startsWith("image/")) {
        return reply.status(422).send({ success: false, error: { code: "NOT_IMAGE", message: "URL does not point to an image" } });
      }
      reply.header("Content-Type", ct);
      reply.header("Content-Length", result.buffer.length);
      reply.header("Cache-Control", "private, max-age=300");
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(result.buffer);
    } catch (err: any) {
      return reply.status(422).send({ success: false, error: { code: "IMAGE_PROXY_FAILED", message: err.message || "Failed to fetch image" } });
    }
  });

  // Review candidate image cache — NAS/browser uploads processed candidate here
  const REVIEW_CACHE_DIR = process.env.REVIEW_CACHE_DIR || "/app/assets/review-cache";

  // Upload a candidate image to the review cache (called by NAS/browser agent)
  app.post<{ Body: { reviewId: string; hash: string; contentBase64: string; ext?: string } }>(
    "/review/cache-candidate",
    { preHandler: [async (req: any, reply: any) => {
      if (!req.user || !req.user.role) {
        return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
      }
    }] },
    async (req: any, reply: any) => {
      const { reviewId, hash, contentBase64, ext } = req.body;
      if (!reviewId || !hash || !contentBase64) {
        return reply.status(422).send({ success: false, error: { code: "MISSING_FIELDS" } });
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(reviewId)) {
        return reply.status(422).send({ success: false, error: { code: "INVALID_REVIEW_ID" } });
      }
      if (!/^[a-f0-9]{64}$/i.test(hash)) {
        return reply.status(422).send({ success: false, error: { code: "INVALID_HASH" } });
      }
      const buf = Buffer.from(contentBase64, "base64");
      if (!buf.length) {
        return reply.status(422).send({ success: false, error: { code: "EMPTY_FILE" } });
      }
      if (buf.length > 10 * 1024 * 1024) {
        return reply.status(422).send({ success: false, error: { code: "FILE_TOO_LARGE" } });
      }
      // Validate image content and derive file extension from sharp metadata
      let meta, fileExt;
      try {
        meta = await sharp(buf).metadata();
        if (!meta.format || !["jpeg", "png", "webp"].includes(meta.format)) {
          return reply.status(422).send({ success: false, error: { code: "NOT_IMAGE" } });
        }
        fileExt = meta.format === "jpeg" ? "jpg" : meta.format;
      } catch {
        return reply.status(422).send({ success: false, error: { code: "NOT_IMAGE" } });
      }
      // Server-side integrity: recompute sha256 and compare
      const actualHash = crypto.createHash("sha256").update(buf).digest("hex");
      if (actualHash !== hash.toLowerCase()) {
        return reply.status(422).send({ success: false, error: { code: "HASH_MISMATCH", message: "Content sha256 does not match submitted hash" } });
      }
      // Server-side re-encode: normalize jpeg/png/webp with sharp
      const reEncoded = await sharp(buf)
        .rotate()
        .toFormat(meta.format || "jpeg", { quality: 90 })
        .toBuffer();
      const normalizedHash = crypto.createHash("sha256").update(reEncoded).digest("hex");
      // Path containment check
      const reviewDir = path.join(REVIEW_CACHE_DIR, reviewId);
      const resolved = path.resolve(reviewDir);
      const cacheRoot = path.resolve(REVIEW_CACHE_DIR);
      if (!resolved.startsWith(cacheRoot + path.sep) && resolved !== cacheRoot) {
        return reply.status(422).send({ success: false, error: { code: "PATH_TRAVERSAL" } });
      }
      await fsp.mkdir(reviewDir, { recursive: true });
      const fileName = normalizedHash + "." + fileExt;
      const filePath = path.join(reviewDir, fileName);
      // Temp file + atomic rename
      const tmpPath = filePath + ".tmp." + crypto.randomBytes(8).toString("hex");
      await fsp.writeFile(tmpPath, reEncoded);
      await fsp.rename(tmpPath, filePath);
      const signingSecret = process.env.REVIEW_CACHE_SIGNING_SECRET;
      if (!signingSecret) {
        return reply.status(500).send({ success: false, error: { code: "SIGNING_NOT_CONFIGURED", message: "REVIEW_CACHE_SIGNING_SECRET is not set" } });
      }
      const maxTtl = 86400000;
      const expiresAt = Math.floor(Date.now() + maxTtl);
      const signPayload = `${reviewId}/${fileName}:${expiresAt}`;
      const sig = crypto.createHmac("sha256", signingSecret).update(signPayload).digest("hex");
      return reply.status(201).send({
        success: true,
        data: { reviewId, hash: normalizedHash, ext: fileExt, url: `/api/v1/review/cached-image/${reviewId}/${fileName}?exp=${expiresAt}&sig=${sig}` },
      });
    }
  );

  app.post("/figures/batch", async (req: any, reply: any) => {
    if (!legacyAdminImportsEnabled()) return legacyAdminImportsDisabled(reply);

    const schema = z.object({
      figures: z.array(z.object({
        slug: z.string().min(1),
        name: z.string().min(1),
        nameJp: z.string().optional(),
        nameEn: z.string().optional(),
        scale: z.string().optional(),
        material: z.string().optional(),
        priceJpy: z.number().int().optional(),
        releaseDate: z.string().optional(),
        heightMm: z.number().int().optional(),
        seriesSlug: z.string().optional(),
        manufacturerSlug: z.string().optional(),
        mfcId: z.string().optional(),
        images: z.array(z.object({
          url: z.string().url(),
          alt: z.string().optional(),
          source: z.string().optional(),
        })).optional(),
      })).min(1).max(100),
    });

    const data = schema.parse(req.body);
    const results: Array<{ slug: string; status: string; id?: string; error?: string }> = [];

    for (const fig of data.figures) {
      try {
        const existing = await app.prisma.figure.findFirst({ where: { slug: fig.slug } });
        if (existing) {
          results.push({ slug: fig.slug, status: "skipped_exists", id: String(existing.id) });
          continue;
        }

        let seriesId: bigint | undefined;
        if (fig.seriesSlug) {
          const series = await app.prisma.series.findUnique({ where: { slug: fig.seriesSlug } });
          seriesId = series?.id;
        }

        let manufacturerId: bigint | undefined;
        if (fig.manufacturerSlug) {
          const mfr = await app.prisma.manufacturer.findUnique({ where: { slug: fig.manufacturerSlug } });
          manufacturerId = mfr?.id;
        }

        const { images, seriesSlug, manufacturerSlug, ...figureData } = fig;
        const figure = await app.prisma.figure.create({
          data: {
            ...figureData,
            seriesId,
            manufacturerId,
            releaseDate: fig.releaseDate ? new Date(fig.releaseDate) : undefined,
          },
        });

        if (images && images.length > 0) {
          const janCode = figure.janCode || "";
          for (let i = 0; i < images.length; i++) {
            const img = images[i];
            if (!janCode) continue;
            try {
              const imageRecords = await processAndStoreImage(img.url, janCode, {
                alt: img.alt || fig.name,
                sortOrder: i,
              });
              for (const rec of imageRecords) {
                await upsertFigureImageRecord(app, {
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
              }
            } catch (err: any) {
              app.log.error({ err, url: img.url }, "Failed to process image during admin import");
            }
          }
        }

        results.push({ slug: fig.slug, status: "created", id: String(figure.id) });
      } catch (err: any) {
        results.push({ slug: fig.slug, status: "error", error: err.message });
      }
    }

    const allKeys = await app.redis.keys("figures:*");
    if (allKeys.length > 0) await app.redis.del(...allKeys);

    return { success: true, data: { total: data.figures.length, results } };
  });
}
