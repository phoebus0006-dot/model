import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import sharp from "sharp";
import crypto from "crypto";
import { processAndStoreImage, upsertFigureImageRecord, downloadImage, validateImageUrl } from "./images.js";
import { scanKeys } from "../security/redisGuard.js";
import { DomainReviewRepository, IllegalReviewTransitionError } from "../domain/review/repository.js";
import { CrawlerJobRepository, isTerminalStatus as isCrawlerJobTerminal } from "../crawler/stateMachine.js";

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

const reviewStatusSchema = z.enum(["pending", "needs_changes", "resolved", "rejected", "archived"]);
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
  "mark_needs_manual_edit",
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
const crawlerJobStatusSchema = z.enum(["created", "queued", "claimed", "running", "completed", "failed", "deferred"]);

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

// === Action → Status mapping (contract §4) ===
const ACTION_TO_STATUS: Record<string, string> = {
  approve_image: "resolved",
  reject_image: "rejected",
  keep_placeholder: "resolved",
  mark_detail_ok: "resolved",
  mark_needs_manual_edit: "needs_changes",
  request_refetch: "needs_changes",
  keep_pending: "pending",
  dismiss_stale: "archived",
};

// === Helper: compute current figure state for enrichment (query-time, §12) ===
async function computeFigureState(app: FastifyInstance, figureId: bigint | null, figureSlug: string | null): Promise<any> {
  if (!figureId && !figureSlug) return null;
  const where = figureId ? { id: figureId, isDeleted: false } : { slug: String(figureSlug), isDeleted: false };
  const fig = await app.prisma.figure.findFirst({
    where,
    select: {
      id: true, slug: true, name: true, description: true,
      scale: true, material: true, priceJpy: true, releaseDate: true, heightMm: true,
      manufacturer: { select: { name: true } },
      series: { select: { name: true } },
      images: { take: 1, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, width: true, height: true, data: true } },
      _count: { select: { images: true } },
    },
  });
  if (!fig) return null;
  const primaryImage = (fig.images || []).length > 0 ? fig.images[0] : null;
  const primaryMeta: any = primaryImage?.data || {};
  const specFields = [fig.scale, fig.material, fig.priceJpy, fig.releaseDate, fig.heightMm, fig.manufacturer?.name, fig.series?.name].filter((f: any) => f != null);
  return {
    id: String(fig.id),
    title: fig.name || "",
    slug: fig.slug,
    imageCount: fig._count?.images ?? 0,
    primaryImage: primaryImage ? {
      imageId: String(primaryImage.id),
      sourceKind: String(primaryMeta.source_kind || ""),
      width: primaryImage.width,
      height: primaryImage.height,
      apiUrl: `/api/v1/figures/images/${primaryImage.id}`,
    } : null,
    detail: {
      descriptionLength: (fig.description || "").length,
      descriptionSnapshot: (fig.description || "").slice(0, 200),
      validSpecCount: specFields.length,
      missingFields: [],
    },
  };
}

// === Helper: check if fingerprint has a human ReviewDecision (§9) ===
async function hasHumanDecision(app: FastifyInstance, fingerprint: string): Promise<boolean> {
  const count = await app.prisma.reviewDecision.count({
    where: { evidenceFingerprint: fingerprint },
  });
  return count > 0;
}

// === Helper: compute evidenceChanged by comparing original evidence with current state (§10) ===
async function computeEvidenceChanged(app: FastifyInstance, item: any): Promise<boolean> {
  const original = item.originalEvidence || item.payload || {};
  const figureId = item.figureId ? BigInt(String(item.figureId)) : null;
  const figureSlug = item.figureSlug ? String(item.figureSlug) : null;
  if (!figureId && !figureSlug) return false;

  const fig = await app.prisma.figure.findFirst({
    where: figureId ? { id: figureId, isDeleted: false } : { slug: figureSlug!, isDeleted: false },
    select: {
      id: true, description: true, scale: true, material: true,
      images: { select: { id: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
    },
  });
  if (!fig) return true; // figure missing → evidence changed

  // Check image set change
  const currentImageIds = fig.images.map((img: any) => String(img.id)).sort();
  const originalImageIds = Array.isArray(original.imageIds)
    ? original.imageIds.map((id: any) => String(id)).sort()
    : [];
  if (originalImageIds.length > 0 && JSON.stringify(currentImageIds) !== JSON.stringify(originalImageIds)) return true;

  // Check description change
  if (typeof original.description === "string" && original.description !== (fig.description || "")) return true;

  // Check approved image missing
  if (original.primaryImageId) {
    const approvedExists = fig.images.some((img: any) => String(img.id) === String(original.primaryImageId));
    if (!approvedExists) return true;
  }

  return false;
}

// === Helper: serialize review item for API output (BigInt-safe, string IDs) ===
function serializeReviewItem(row: any): any {
  const out: any = { ...row };
  for (const key of ["figureId", "reviewerId"]) {
    if (out[key] != null && typeof out[key] === "bigint") {
      out[key] = out[key].toString();
    }
  }
  if (out.id && typeof row.id === "bigint") {
    out.id = row.id.toString();
  }
  for (const key of ["createdAt", "updatedAt", "decisionAt"]) {
    if (out[key] instanceof Date) out[key] = out[key].toISOString();
  }
  return out;
}

// === Review Routes (exported for integration testing) ===
// PostgreSQL is the source of truth; Redis is cache/index/lock only.
export async function registerReviewRoutes(app: FastifyInstance) {
  // GET /review/items — PG source of truth with _count.images, take:1 primary image
  app.get("/review/items", async (req: any, reply: any) => {
    const query = reviewQuerySchema.parse(req.query || {});
    const statusFilter = query.status || "pending";
    const showAll = statusFilter === ALL_STATUSES;

    // Try Redis cache first (TTL 60s) — PG is still source of truth
    const cacheKey = `review:list:${statusFilter}:${query.type || ""}:${query.riskType || ""}:${query.suggestedAction || ""}:${query.limit}:${query.offset}`;
    const cached = await app.redis.get(cacheKey);

    let items: any[] = [];
    let total = 0;
    let fromCache = false;

    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        items = parsed.items || [];
        total = parsed.total || 0;
        fromCache = true;
      } catch {}
    }

    if (!fromCache) {
      // PG is the source of truth
      const where: any = {};
      if (!showAll) {
        where.status = statusFilter;
      }
      if (query.type) where.type = query.type;
      if (query.riskType) where.riskType = query.riskType;
      if (query.suggestedAction) where.suggestedAction = query.suggestedAction;

      const offset = query.offset || 0;
      const [rows, count] = await Promise.all([
        app.prisma.reviewItem.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: query.limit,
          skip: offset,
        }),
        app.prisma.reviewItem.count({ where }),
      ]);
      items = rows.map((r: any) => serializeReviewItem(r));
      total = count;

      // Cache the list (TTL 60s) — PG remains source of truth
      await app.redis.set(cacheKey, JSON.stringify({ items, total }), "EX", 60);
    }

    // Legacy fallback: if PG has no items, check Redis for legacy data
    let legacy = false;
    if (items.length === 0 && total === 0 && !fromCache) {
      const legacyIds = await app.redis.zrevrange("review:items", 0, -1);
      const legacyItems: any[] = [];
      for (const id of legacyIds) {
        const raw = await app.redis.get(`review:item:${id}`);
        if (!raw) continue;
        try {
          const item = JSON.parse(raw);
          if (!showAll && item.status !== statusFilter) continue;
          if (query.type && item.type !== query.type) continue;
          if (query.riskType && item.riskType !== query.riskType) continue;
          if (query.suggestedAction && item.suggestedAction !== query.suggestedAction) continue;
          legacyItems.push(item);
        } catch {}
      }
      if (legacyItems.length > 0) {
        items = legacyItems;
        total = legacyItems.length;
        legacy = true;
      }
    }

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
          images: { take: 1, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
          _count: { select: { images: true } },
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
          images: { take: 1, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
          _count: { select: { images: true } },
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
        const primaryImage = (fig.images || []).length > 0 ? fig.images[0] : null;
        const primaryMeta = primaryImage?.data || {};
        const specFields = [fig.scale, fig.material, fig.priceJpy, fig.releaseDate, fig.heightMm, fig.manufacturer?.name, fig.series?.name].filter((f: any) => f != null);
        item.currentFigure = {
          id: String(fig.id),
          title: fig.name || "",
          slug: fig.slug,
          imageCount: fig._count?.images ?? 0,
          primaryImage: primaryImage ? {
            imageId: String(primaryImage.id),
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
      // Mark original evidence separately from current state
      item.originalEvidence = item.originalEvidence || item.payload || null;
    }

    return {
      success: true,
      data: items,
      meta: { count: items.length, total, limit: query.limit, offset: query.offset || 0, defaultStatus: statusFilter, legacy },
    };
  });

  // GET /review/items/:id — single item with real-time current state
  app.get("/review/items/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };

    // PG is source of truth (with Redis read-through cache via DomainReviewRepository)
    const repo = new DomainReviewRepository(app.prisma, app.redis);
    const item = await repo.getById(id);
    if (item) {
      const figureId = item.figureId ? BigInt(String(item.figureId)) : null;
      const figureSlug = item.figureSlug ? String(item.figureSlug) : null;
      const currentState = await computeFigureState(app, figureId, figureSlug);
      return {
        success: true,
        data: {
          ...item,
          originalEvidence: item.originalEvidence || item.payload || null,
          currentState,
        },
      };
    }

    // Legacy fallback: check Redis
    const raw = await app.redis.get(`review:item:${id}`);
    if (raw) {
      try {
        const legacyItem = JSON.parse(raw);
        const figureId = legacyItem.figureId ? BigInt(String(legacyItem.figureId)) : null;
        const figureSlug = legacyItem.figureSlug ? String(legacyItem.figureSlug) : null;
        const currentState = await computeFigureState(app, figureId, figureSlug);
        return {
          success: true,
          data: {
            ...legacyItem,
            originalEvidence: legacyItem.payload || null,
            currentState,
            legacy: true,
          },
        };
      } catch {}
    }

    return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
  });

  // GET /review/stats — PG source of truth
  app.get("/review/stats", async () => {
    const statusCounts = await app.prisma.reviewItem.groupBy({
      by: ["status"],
      _count: { id: true },
    });

    const stats: Record<string, number> = {
      total: 0,
      pending: 0,
      needs_changes: 0,
      resolved: 0,
      rejected: 0,
      archived: 0,
      pending_image_review: 0,
      pending_detail_review: 0,
      pending_rewrite: 0,
      pending_figure_import: 0,
    };

    for (const row of statusCounts) {
      const s = row.status;
      const count = row._count?.id ?? 0;
      stats.total += count;
      if (s === "pending") stats.pending += count;
      else if (s === "needs_changes") stats.needs_changes += count;
      else if (s === "resolved") stats.resolved += count;
      else if (s === "rejected") stats.rejected += count;
      else if (s === "archived") stats.archived += count;
    }

    // Pending by type
    const pendingByType = await app.prisma.reviewItem.groupBy({
      by: ["type"],
      where: { status: "pending" },
      _count: { id: true },
    });
    for (const row of pendingByType) {
      const t = row.type;
      const count = row._count?.id ?? 0;
      if (t === "image_review") stats.pending_image_review = count;
      else if (t === "detail_review") stats.pending_detail_review = count;
      else if (t === "rewrite") stats.pending_rewrite = count;
      else if (t === "figure_import") stats.pending_figure_import = count;
    }

    return { success: true, data: stats };
  });

  // POST /review/items — create with enhanced duplicate suppression (§9)
  app.post("/review/items", async (req: any, reply: any) => {
    const data = reviewItemSchema.parse(req.body);
    const repo = new DomainReviewRepository(app.prisma, app.redis);

    // Build domain input from API input
    const domainInput: any = {
      type: data.type,
      title: data.title,
      figureId: data.figureId,
      figureSlug: data.figureSlug,
      riskType: data.riskType,
      riskReason: data.riskReason,
      status: data.status,
      priority: data.priority,
      confidence: data.confidence,
      source: data.source,
      sourceId: data.sourceId,
      suggestedAction: data.suggestedAction,
      payload: data.payload,
      notes: data.notes,
      evidenceFingerprint: data.evidenceFingerprint,
      forceReopen: data.forceReopen,
      automation: data.automation,
      candidateImage: data.candidateImage,
      currentPublicImage: data.currentPublicImage,
      detailSnapshot: data.detailSnapshot,
      // Canonical evidence fields
      candidateAsset: data.candidateImage ? {
        source: data.candidateImage.source,
        url: data.candidateImage.url,
        imageId: data.candidateImage.imageId,
        width: data.candidateImage.width,
        height: data.candidateImage.height,
      } : undefined,
    };

    // Compute canonical fingerprint for suppression check
    const canonicalFp = repo.computeFingerprint(domainInput);

    // Enhanced suppression check (§9): only suppress duplicate_decided
    // when there's a human ReviewDecision for this fingerprint
    if (!data.forceReopen) {
      const existing = await app.prisma.reviewItem.findFirst({
        where: {
          evidenceFingerprint: canonicalFp,
          status: { not: "archived" },
        },
        orderBy: { createdAt: "desc" },
      });

      if (existing) {
        const existingStatus = repo.reconcileStatus(existing.status as string);
        if (existingStatus === "resolved" || existingStatus === "rejected") {
          // Check for human decision (§9)
          const hasDecision = await hasHumanDecision(app, canonicalFp);
          if (hasDecision) {
            return reply.status(200).send({
              success: true,
              data: serializeReviewItem(existing),
              suppressed: true,
              reason: "duplicate_decided",
            });
          }
          // No human decision — legacy stale item, don't suppress
          // Force create a new item
          domainInput.forceReopen = true;
        } else {
          // pending or needs_changes — duplicate_active
          return reply.status(200).send({
            success: true,
            data: serializeReviewItem(existing),
            suppressed: true,
            reason: "duplicate_active",
          });
        }
      }
    }

    // Create via domain repository (forceReopen bypasses its internal check
    // since we already did our enhanced check above)
    try {
      const result = await repo.create(domainInput);
      const statusCode = result.created ? 201 : 200;
      return reply.status(statusCode).send({
        success: true,
        data: result.item,
        suppressed: result.suppressed,
        reason: result.reason,
      });
    } catch (err: any) {
      if (err.name === "FingerprintMismatchError") {
        return reply.status(422).send({
          success: false,
          error: { code: "FINGERPRINT_MISMATCH", message: err.message },
        });
      }
      throw err;
    }
  });

  // PUT /review/items/:id — update (PG source of truth)
  app.put("/review/items/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const update = reviewUpdateSchema.parse(req.body);

    const existing = await app.prisma.reviewItem.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
    }

    const updateData: any = { updatedAt: new Date() };
    if (update.status) updateData.status = update.status;
    if (update.priority !== undefined) updateData.priority = update.priority;
    if (update.confidence !== undefined) updateData.confidence = update.confidence;
    if (update.payload !== undefined) updateData.payload = update.payload;
    if (update.notes !== undefined) updateData.notes = update.notes;
    if (update.automation !== undefined) updateData.automation = update.automation;
    if (update.candidateImage !== undefined) updateData.candidateImage = update.candidateImage;
    if (update.suggestedAction !== undefined) updateData.suggestedAction = update.suggestedAction;
    if (update.currentPublicImage !== undefined) updateData.currentPublicImage = update.currentPublicImage;

    const updated = await app.prisma.reviewItem.update({
      where: { id },
      data: updateData,
    });

    // Invalidate Redis cache
    await app.redis.del(`review:item:${id}`);

    return { success: true, data: serializeReviewItem(updated) };
  });

  // POST /review/items/:id/recheck — return only, do NOT modify status (§8)
  app.post("/review/items/:id/recheck", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };

    // Fetch from PG (source of truth)
    const row = await app.prisma.reviewItem.findUnique({ where: { id } });
    let item: any;
    if (row) {
      item = serializeReviewItem(row);
    } else {
      // Legacy fallback
      const raw = await app.redis.get(`review:item:${id}`);
      if (!raw) {
        return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
      }
      item = JSON.parse(raw);
      item.legacy = true;
    }

    // Compute current state (real-time from database)
    const figureId = item.figureId ? BigInt(String(item.figureId)) : null;
    const figureSlug = item.figureSlug ? String(item.figureSlug) : null;
    const currentState = await computeFigureState(app, figureId, figureSlug);

    // Evaluate problems (recheck logic)
    const problems = await evaluateReviewItem(app, item);

    // Compute recommendedStatus (does NOT auto-resolve — §8)
    const hasDeterministicProblem = problems.length > 0 && !problems.some(p => p.includes("需人工判断"));
    const recommendedStatus = problems.length === 0
      ? "resolved"
      : hasDeterministicProblem
        ? "needs_changes"
        : "pending";

    // Compute evidenceChanged (§10)
    const evidenceChanged = await computeEvidenceChanged(app, item);

    return {
      success: true,
      data: {
        problems,
        currentState,
        recommendedStatus,
        evidenceChanged,
      },
    };
  });

  // POST /review/items/:id/action — transaction with lock, 409 for illegal transitions (§6, §7, §15, §16)
  app.post("/review/items/:id/action", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const actionBody = z.object({
      action: reviewActionSchema,
      notes: z.string().optional(),
    }).parse(req.body || {});

    // Distributed lock via Redis (prevent concurrent actions on same item)
    const lockKey = `review:lock:${id}`;
    const lockAcquired = await (app.redis as any).set(lockKey, "1", "EX", 10, "NX");
    if (!lockAcquired) {
      return reply.status(409).send({
        success: false,
        error: { code: "CONCURRENT_ACTION", message: "Another action is in progress on this item" },
      });
    }

    try {
      const repo = new DomainReviewRepository(app.prisma, app.redis);
      const targetStatus = ACTION_TO_STATUS[actionBody.action] || "pending";

      // For keep_pending: statusAfter stays "pending" (§7)
      // For request_refetch: idempotent CrawlerJob creation (§16)
      let crawlerJobId: string | undefined;

      if (actionBody.action === "request_refetch") {
        // Check existing crawlerJobId on the ReviewItem
        const existing = await app.prisma.reviewItem.findUnique({ where: { id } });
        if (!existing) {
          return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
        }

        const existingJobId = existing.crawlerJobId;
        if (existingJobId) {
          // Check if the existing CrawlerJob is non-terminal
          const existingJob = await app.prisma.crawlerJob.findUnique({ where: { id: existingJobId } });
          if (existingJob && !isCrawlerJobTerminal(existingJob.status)) {
            // Reuse existing non-terminal job (idempotent — §16)
            crawlerJobId = existingJobId;
          }
        }

        if (!crawlerJobId) {
          // Create a new CrawlerJob in PG
          const crawlerRepo = new CrawlerJobRepository(app.prisma, app.redis);
          const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          // Determine source from item payload
          const itemData = serializeReviewItem(existing);
          const snap = (itemData.payload || {}).detailSnapshot || {};
          const itemSource = String(itemData.source || "").toLowerCase();
          const rawSourceId = String(itemData.sourceId || "");
          const rawMfcId = String(snap.mfc_id || snap.mfcId || (itemData.payload || {}).mfcId || "");
          const rawJanCode = String(snap.jan_code || snap.janCode || (itemData.payload || {}).janCode || "");
          const rawHobbySearchId = String(snap.hobbysearch_id || snap.hobbySearchId || snap.hobby_search_id || (itemData.payload || {}).hobbySearchId || "");

          const isJan = (s: string) => /^\d{8}$/.test(s) || /^\d{13}$/.test(s);
          const isMfcItemId = (s: string) => /^\d{1,8}$/.test(s);

          let jobSource = "manual";
          let jobRunner = "local_browser";
          let jobNotes: string | undefined;
          const jobPayload: any = {
            figureId: itemData.figureId ? String(itemData.figureId) : null,
            figureSlug: itemData.figureSlug || "",
            reason: itemData.riskReason || `Refetch from review item ${id}`,
            reviewItemId: id,
            needImages: itemData.type !== "detail_review",
            needDetails: itemData.type === "detail_review",
          };

          if (rawMfcId && isMfcItemId(rawMfcId)) {
            jobSource = "mfc";
            jobPayload.mfcId = rawMfcId;
          } else if (itemSource.includes("mfc") && rawSourceId && isMfcItemId(rawSourceId)) {
            jobSource = "mfc";
            jobPayload.mfcId = rawSourceId;
          } else if (rawJanCode && isJan(rawJanCode)) {
            jobSource = "amiami";
            jobPayload.janCode = rawJanCode;
          } else if (isJan(rawSourceId)) {
            jobSource = "amiami";
            jobPayload.janCode = rawSourceId;
          } else if (rawHobbySearchId) {
            jobSource = "hobbysearch";
            jobPayload.hobbySearchId = rawHobbySearchId;
          } else {
            jobRunner = "manual";
            jobNotes = `无法自动判断来源: source=${itemData.source || ""}, sourceId=${rawSourceId}`;
            jobPayload.unresolvedSource = true;
          }

          await crawlerRepo.create({
            id: jobId,
            source: jobSource,
            task: "fetch_item",
            runner: jobRunner,
            payload: jobPayload,
            linkedReviewItemId: id,
            notes: jobNotes,
            automation: { provider: "manual", workflow: "review-refetch" },
          });
          await crawlerRepo.releaseToQueued(jobId);
          crawlerJobId = jobId;
        }
      }

      // Record the decision via domain repository (transaction with transition validation)
      const reviewer = (req as any).user?.userId ? BigInt(String((req as any).user.userId)) : null;
      const reviewerRole = (req as any).user?.role || "admin";

      try {
        const result = await repo.recordDecision({
          reviewItemId: id,
          action: actionBody.action,
          statusAfter: targetStatus,
          reviewerId: reviewer,
          reviewerRole,
          decisionReason: actionBody.notes,
          crawlerJobId,
        });

        // Purge figure display caches when image decisions are made (no FLUSHDB)
        if (["approve_image", "reject_image", "keep_placeholder"].includes(actionBody.action)) {
          const figKeys = await scanKeys(app.redis, `figures:detail:*`);
          if (figKeys.length > 0) await app.redis.unlink(...figKeys);
        }

        // Invalidate list cache
        const listKeys = await scanKeys(app.redis, "review:list:*");
        for (const k of listKeys) await app.redis.del(k);

        return {
          success: true,
          data: {
            item: result.item,
            action: actionBody.action,
            decision: result.decision,
            crawlerJobId: crawlerJobId || null,
          },
        };
      } catch (err: any) {
        if (err.name === "IllegalReviewTransitionError") {
          return reply.status(409).send({
            success: false,
            error: {
              code: "ILLEGAL_TRANSITION",
              message: err.message,
              from: err.from,
              to: err.to,
            },
          });
        }
        if (err.name === "ReviewItemNotFoundError") {
          return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
        }
        throw err;
      }
    } finally {
      // Release lock
      await app.redis.del(lockKey);
    }
  });

  // POST /review/items/bulk/cleanup — PG source of truth
  app.post("/review/items/bulk/cleanup", async (req: any, reply: any) => {
    const body = z.object({
      dryRun: z.boolean().default(false),
      markStale: z.boolean().default(true),
      olderThanDays: z.coerce.number().int().min(1).default(1),
    }).parse(req.body || {});

    const cutoff = new Date(Date.now() - body.olderThanDays * 86400000);

    // Find old resolved rewrite items from localized-description-sync
    const candidates = await app.prisma.reviewItem.findMany({
      where: {
        type: "rewrite",
        source: "localized-description-sync",
        status: { in: ["resolved", "archived"] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true },
    });

    const updated: string[] = [];
    for (const { id } of candidates) {
      if (body.dryRun) {
        updated.push(id);
        continue;
      }
      if (body.markStale) {
        const now = new Date().toISOString();
        await app.prisma.reviewItem.update({
          where: { id },
          data: {
            status: "archived",
            updatedAt: new Date(),
          },
        });
      }
      updated.push(id);
    }

    return {
      success: true,
      data: {
        updatedCount: updated.length,
        totalScanned: candidates.length,
        dryRun: body.dryRun,
        sampleUpdated: updated.slice(0, 5),
      },
    };
  });
}

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

  // Phase 1+2 review-api-integration: register PG-backed review routes (contract §1-§16)
  registerReviewRoutes(app);

  app.post("/review/items/:id/apply", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    // Phase 1+2: PG is source of truth (contract §1). Use DomainReviewRepository
    // which has a Redis read-through cache for legacy compatibility.
    const repo = new DomainReviewRepository(app.prisma, app.redis);
    const existingItem = await repo.getById(id);
    if (!existingItem) {
      return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
    }

    const item: any = existingItem;
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

      const now = new Date();
      const problems = await evaluateReviewItem(app, item);
      const nextStatus = problems.length === 0 ? "resolved" : "needs_changes";
      const noteText = problems.length === 0
        ? `Applied and rechecked at ${now.toISOString()}`
        : `Applied but still needs changes: ${problems.join("; ")}`;
      const existingNotes = item.notes ? String(item.notes) : "";
      const updatedNotes = existingNotes ? `${existingNotes}\n${noteText}` : noteText;
      const updatedPayload = { ...(item.payload || {}), reviewProblems: problems, lastCheckedAt: now.toISOString() };

      // Phase 1+2: persist to PG (source of truth) + invalidate Redis cache.
      // Record a ReviewDecision (append-only audit trail, contract §6).
      const reviewer = (req as any).user?.userId ? BigInt(String((req as any).user.userId)) : null;
      const reviewerRole = (req as any).user?.role || "admin";
      const applyResult = await repo.recordDecision({
        reviewItemId: id,
        action: "apply",
        statusAfter: nextStatus,
        reviewerId: reviewer,
        reviewerRole,
        decisionReason: noteText,
        metadata: { applied, problems },
      });
      // Update payload + notes (recordDecision doesn't touch these)
      const updatedRow = await app.prisma.reviewItem.update({
        where: { id },
        data: {
          payload: updatedPayload as any,
          notes: updatedNotes,
          updatedAt: now,
        },
      });
      await app.redis.del(`review:item:${id}`);
      const updatedItem = { ...item, ...applyResult.item, payload: updatedPayload, notes: updatedNotes };

      // Phase 1+2 runtime-security: SCAN instead of KEYS (contract §14).
      // Use targeted namespaces rather than "figures:*" to avoid touching
      // any future figures:review:* or figures:crawler:* keys.
      const detailKeys = await scanKeys(app.redis, "figures:detail:*");
      if (detailKeys.length > 0) await app.redis.unlink(...detailKeys);
      const listKeys = await scanKeys(app.redis, "figures:list:*");
      if (listKeys.length > 0) await app.redis.unlink(...listKeys);

      return { success: true, data: { item: updatedItem, applied, problems } };
    } catch (err: any) {
      // §15: illegal state transitions return 409 Conflict
      if (err.name === "IllegalReviewTransitionError") {
        return reply.status(409).send({
          success: false,
          error: {
            code: "ILLEGAL_TRANSITION",
            message: err.message,
            from: err.from,
            to: err.to,
          },
        });
      }
      return reply.status(422).send({
        success: false,
        error: { code: "REVIEW_APPLY_FAILED", message: err.message || "Failed to apply review item" },
      });
    }
  });

  // === Crawler job endpoints: PG source of truth via CrawlerJobRepository ===
  // Phase 1+2 crawler-state: PostgreSQL is the source of truth for CrawlerJob
  // rows; Redis is ONLY a cache mirror + ZSET queue index (rebuildable from PG).

  function serializeCrawlerJob(row: any): any {
    const out: any = { ...row };
    for (const key of ["createdAt", "updatedAt", "claimedAt", "runningAt", "completedAt", "notBefore"]) {
      if (out[key] instanceof Date) out[key] = out[key].toISOString();
    }
    return out;
  }

  app.get("/crawler/jobs", async (req: any) => {
    const query = crawlerJobQuerySchema.parse(req.query || {});
    const crawlerRepo = new CrawlerJobRepository(app.prisma, app.redis);
    const { jobs, total } = await crawlerRepo.list({
      status: query.status as any,
      runner: query.runner,
      source: query.source,
      limit: query.limit,
    });
    return {
      success: true,
      data: jobs.map(serializeCrawlerJob),
      meta: { count: jobs.length, total, limit: query.limit },
    };
  });

  app.post("/crawler/jobs", async (req: any, reply: any) => {
    const data = crawlerJobSchema.parse(req.body);
    const crawlerRepo = new CrawlerJobRepository(app.prisma, app.redis);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = await crawlerRepo.create({
      id,
      source: data.source,
      task: data.task,
      runner: data.runner,
      priority: data.priority,
      payload: data.payload,
      maxAttempts: data.maxAttempts,
      notBefore: data.notBefore ? new Date(data.notBefore) : undefined,
      notes: data.notes,
      automation: data.automation,
    });
    // Auto-release to queued for backwards compat with admin-created jobs
    // (legacy behavior: admin-created jobs were immediately visible in the queue)
    await crawlerRepo.releaseToQueued(id);
    const released = await crawlerRepo.get(id);
    return reply.status(201).send({ success: true, data: serializeCrawlerJob(released || job) });
  });

  app.post("/crawler/jobs/claim", async (req: any) => {
    const data = crawlerClaimSchema.parse(req.body);
    const crawlerRepo = new CrawlerJobRepository(app.prisma, app.redis);
    // Queue-wide claim (canaryMode=false) — runners consume any matching job
    const results = await crawlerRepo.claimJobs({
      runner: data.runner,
      workerId: data.workerId,
      limit: data.limit,
      canaryMode: false,
    });
    const claimed = results.map((r: any) => serializeCrawlerJob(r.job));
    return { success: true, data: claimed, meta: { count: claimed.length } };
  });

  app.get("/crawler/jobs/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const crawlerRepo = new CrawlerJobRepository(app.prisma, app.redis);
    const job = await crawlerRepo.get(id);
    if (!job) {
      return reply.status(404).send({ success: false, error: { code: "CRAWLER_JOB_NOT_FOUND", message: "Crawler job not found" } });
    }
    return { success: true, data: serializeCrawlerJob(job) };
  });

  app.put("/crawler/jobs/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const update = crawlerJobUpdateSchema.parse(req.body);
    const crawlerRepo = new CrawlerJobRepository(app.prisma, app.redis);
    const existing = await crawlerRepo.get(id);
    if (!existing) {
      return reply.status(404).send({ success: false, error: { code: "CRAWLER_JOB_NOT_FOUND" } });
    }

    // If status is changing, route through the state machine for validation.
    // Otherwise, update non-status fields directly in PG.
    let job = existing;
    if (update.status && update.status !== existing.status) {
      try {
        switch (update.status) {
          case "running":
            job = await crawlerRepo.start(id);
            break;
          case "completed":
            job = await crawlerRepo.complete(id, update.resultSummary ?? update.result ?? null, update.result ?? null);
            break;
          case "failed":
            job = await crawlerRepo.fail(id, update.error || "Unknown error");
            break;
          case "deferred":
            job = await crawlerRepo.defer(id, update.notBefore ? new Date(update.notBefore) : new Date(Date.now() + 60000), update.notes || undefined);
            break;
          case "queued":
            // Release claimed → queued (re-queue without incrementing attempts)
            job = await crawlerRepo.releaseClaim(id);
            break;
          case "created":
            // Admin retry: failed → created
            job = await crawlerRepo.adminRetry(id);
            break;
          default:
            return reply.status(409).send({
              success: false,
              error: { code: "ILLEGAL_TRANSITION", message: `Cannot transition to ${update.status} via PUT` },
            });
        }
      } catch (err: any) {
        if (err.name === "IllegalTransitionError") {
          return reply.status(409).send({
            success: false,
            error: { code: "ILLEGAL_TRANSITION", message: err.message, from: err.from, to: err.to },
          });
        }
        throw err;
      }
    }

    // Apply non-status field updates directly in PG (notes, priority, payload, etc.)
    const sideFields: any = { updatedAt: new Date() };
    if (update.notes !== undefined) sideFields.notes = update.notes;
    if (update.priority !== undefined) sideFields.priority = update.priority;
    if (update.payload !== undefined) sideFields.payload = update.payload;
    if (update.result !== undefined) sideFields.result = update.result;
    if (update.resultSummary !== undefined) sideFields.resultSummary = update.resultSummary;
    if (update.error !== undefined) sideFields.error = update.error;
    if (update.runner !== undefined) sideFields.runner = update.runner;
    if (update.notBefore !== undefined) sideFields.notBefore = update.notBefore ? new Date(update.notBefore) : null;

    if (Object.keys(sideFields).length > 1) {
      job = await app.prisma.crawlerJob.update({ where: { id }, data: sideFields });
      // Mirror to Redis cache
      await app.redis.set(`crawler:job:${id}`, JSON.stringify(job));
    }

    return { success: true, data: serializeCrawlerJob(job) };
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

    const recentKeys = await scanKeys(app.redis, "legacy:import:result:*");
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

    const detailKeysAfterImport = await scanKeys(app.redis, "figures:detail:*");
    if (detailKeysAfterImport.length > 0) await app.redis.unlink(...detailKeysAfterImport);
    const listKeysAfterImport = await scanKeys(app.redis, "figures:list:*");
    if (listKeysAfterImport.length > 0) await app.redis.unlink(...listKeysAfterImport);

    return { success: true, data: { total: data.figures.length, results } };
  });
}
