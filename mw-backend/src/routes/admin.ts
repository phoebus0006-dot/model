import { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminCacheRoutes } from "../modules/admin-cache/routes.js";
import { adminUserRoutes } from "../modules/admin-users/routes.js";
import { adminCrawlerRoutes } from "../modules/admin-crawler/routes.js";
import { adminImportRoutes } from "../modules/admin-import/routes.js";
import { adminReviewRoutes } from "../modules/reviews/routes.js";
import { adminAigcRoutes } from "../modules/admin-aigc/routes.js";
import { adminStatsRoutes } from "../modules/admin-stats/routes.js";
import { adminImageProxyRoutes } from "../modules/admin-image-proxy/routes.js";
import { scanKeys } from "../shared/cache/scan-keys.js";
import bcrypt from "bcryptjs";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import sharp from "sharp";
import crypto from "crypto";
import { processAndStoreImage, upsertFigureImageRecord, downloadImage, validateImageUrl } from "./images.js";

Object.defineProperty(BigInt.prototype, "toJSON", {
  value: function () { return this.toString(); },
  writable: true, configurable: true,
});

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



  // GET /review/stats: statistics for the review queue (P0 fix: stats bar)



  // Track RQ: unified action endpoint for review queue (image/detail actions)

  // Track RQ: bulk cleanup - mark old resolved rewrite items as stale







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


  await app.register(adminCacheRoutes);
  await app.register(adminUserRoutes);
  await app.register(adminCrawlerRoutes);
  await app.register(adminImportRoutes);
  await app.register(adminReviewRoutes);
  await app.register(adminAigcRoutes);
  await app.register(adminStatsRoutes);
  await app.register(adminImageProxyRoutes);








  // Admin-only review image proxy with SSRF protection

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

}
