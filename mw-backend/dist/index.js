// src/app.ts
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fs4 from "fs";
import sharp4 from "sharp";
import path4 from "path";
import crypto7 from "crypto";
import { PrismaClient as PrismaClient2 } from "@prisma/client";
import Redis2 from "ioredis";

// src/plugins/prisma.ts
import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";
var prismaPlugin = fp(async (app) => {
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } }
  });
  await prisma.$connect();
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});

// src/plugins/redis.ts
import fp2 from "fastify-plugin";
import Redis from "ioredis";
var redisPlugin = fp2(async (app) => {
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379", {
    maxRetriesPerRequest: 3
  });
  redis.on("error", (err) => app.log.error({ err }, "Redis error:"));
  redis.on("connect", () => app.log.info("Redis connected"));
  app.decorate("redis", redis);
  app.addHook("onClose", async () => {
    await redis.quit();
  });
});

// src/routes/figures.ts
import { z as z2 } from "zod";

// src/shared/cache/scan-keys.ts
var DEFAULT_COUNT = 200;
var DEFAULT_BATCH_SIZE = 200;
async function scanKeys(redis, pattern, options) {
  const count = options?.count ?? DEFAULT_COUNT;
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  let cursor = "0";
  const allKeys = [];
  const seen = /* @__PURE__ */ new Set();
  do {
    if (options?.signal?.aborted) {
      return { matched: allKeys.length, deleted: 0, failed: 0, truncated: true };
    }
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", String(count));
    cursor = nextCursor;
    for (const k of keys) {
      if (!seen.has(k)) {
        seen.add(k);
        allKeys.push(k);
      }
    }
  } while (cursor !== "0");
  if (allKeys.length === 0) return { matched: 0, deleted: 0, failed: 0, truncated: false };
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < allKeys.length; i += batchSize) {
    if (options?.signal?.aborted) {
      return { matched: allKeys.length, deleted, failed, truncated: true };
    }
    const batch = allKeys.slice(i, i + batchSize);
    try {
      const result = await redis.unlink(...batch);
      deleted += result;
    } catch {
      failed += batch.length;
    }
  }
  return { matched: allKeys.length, deleted, failed, truncated: false };
}

// src/routes/images.ts
import { z } from "zod";
import http from "http";
import https from "https";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import dns from "dns";
var MAX_IMAGE_SIZE = 10 * 1024 * 1024;
var DOWNLOAD_TIMEOUT = 15e3;
var ASSETS_PATH = process.env.ASSETS_PATH || "/app/assets";
var MAX_REDIRECTS = 5;
var IMAGE_SIZES = {
  raw: { width: null, quality: 100 },
  detail: { width: 1200, quality: 85 },
  thumb: { width: 300, quality: 80 }
};
var BLOCKED_HOSTS = /* @__PURE__ */ new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "169.254.169.254",
  "metadata.google.internal"
]);
function isPrivateIp(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p))) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 127) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("FE80:") || ip.startsWith("fe80:")) return true;
  if (ip.startsWith("ff") || ip.startsWith("FF")) return true;
  const v4match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4match) return isPrivateIp(v4match[1]);
  return false;
}
async function resolveAndValidateHost(hostname) {
  try {
    const addresses = await dns.promises.resolve4(hostname);
    if (addresses.length === 0) {
      const aaaa = await dns.promises.resolve6(hostname);
      if (aaaa.length === 0) return { ok: false, reason: "DNS resolution returned no addresses" };
      for (const addr of aaaa) {
        if (isPrivateIp(addr)) return { ok: false, reason: `DNS resolved to private IPv6: ${addr}` };
      }
      return { ok: true, address: aaaa[0] };
    }
    for (const addr of addresses) {
      if (isPrivateIp(addr)) return { ok: false, reason: `DNS resolved to private IP: ${addr}` };
    }
    return { ok: true, address: addresses[0] };
  } catch (e) {
    return { ok: false, reason: `DNS resolution failed: ${e.message || e}` };
  }
}
async function validateImageUrl(imageUrl) {
  try {
    const u = new URL(imageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: "Only http(s) URLs are allowed" };
    }
    const host = u.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(host)) return { ok: false, reason: "Blocked host" };
    const resolved = await resolveAndValidateHost(host);
    if (!resolved.ok) return { ok: false, reason: resolved.reason || "Host validation failed" };
    return { ok: true, resolvedAddress: resolved.address };
  } catch (e) {
    return { ok: false, reason: "Invalid URL: " + (e?.message || "") };
  }
}
function validateJanCode(janCode) {
  if (!janCode || typeof janCode !== "string") return false;
  if (/[\\/]/.test(janCode)) return false;
  if (janCode.includes("..")) return false;
  if (janCode.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(janCode) || janCode === "no-jancode";
}
function validateSha256(sha256) {
  if (!sha256 || typeof sha256 !== "string") return false;
  return /^[a-f0-9]{64}$/i.test(sha256);
}
function safeBigInt(value) {
  try {
    if (!/^-?\d+$/.test(value)) return null;
    return BigInt(value);
  } catch {
    return null;
  }
}
async function downloadImage(imageUrl, redirectDepth = 0) {
  if (redirectDepth > MAX_REDIRECTS) {
    return Promise.reject(new Error("Too many redirects"));
  }
  const urlCheck = await validateImageUrl(imageUrl);
  if (!urlCheck.ok) {
    return Promise.reject(new Error("URL validation failed: " + (urlCheck.reason || "blocked")));
  }
  return new Promise((resolve, reject) => {
    const proto = imageUrl.startsWith("https") ? https : http;
    const urlObj = new URL(imageUrl);
    const req = proto.request(
      {
        hostname: urlCheck.resolvedAddress || urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36",
          Accept: "image/webp,image/*,*/*;q=0.8",
          Referer: new URL(imageUrl).origin + "/"
        },
        timeout: DOWNLOAD_TIMEOUT,
        servername: urlObj.hostname
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, imageUrl).toString();
          downloadImage(redirectUrl, redirectDepth + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }
        const contentType = res.headers["content-type"];
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_IMAGE_SIZE) {
            req.destroy();
            reject(new Error("Image exceeds maximum size of 10MB"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({ buffer, contentType });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Download timed out"));
    });
    req.end();
  });
}
function computeSha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
function getImageDir(janCode) {
  return path.join(ASSETS_PATH, "figures", janCode);
}
function getImageFilePath(janCode, sha256, size) {
  if (!validateJanCode(janCode)) throw new Error("Invalid janCode");
  if (!validateSha256(sha256)) throw new Error("Invalid sha256");
  return path.join(getImageDir(janCode), `${sha256}_${size}.webp`);
}
async function upsertFigureImageRecord(app, data) {
  const source = data.source ? String(data.source) : null;
  const sha256 = data.sha256 ? String(data.sha256) : null;
  const size = String(data.size || "raw");
  const whereBase = { figureId: data.figureId, size };
  let existing = source ? await app.prisma.figureImage.findFirst({
    where: { ...whereBase, source },
    orderBy: { id: "asc" }
  }) : null;
  if (!existing && sha256) {
    existing = await app.prisma.figureImage.findFirst({
      where: { ...whereBase, sha256 },
      orderBy: { id: "asc" }
    });
  }
  const payload = {
    figureId: data.figureId,
    janCode: data.janCode ?? null,
    sha256,
    size,
    format: data.format || "webp",
    width: data.width ?? null,
    height: data.height ?? null,
    fileSize: data.fileSize ?? null,
    alt: data.alt || null,
    sortOrder: data.sortOrder ?? 0,
    source,
    isNsfw: data.isNsfw || false,
    data: data.data ?? null
  };
  const image = existing ? await app.prisma.figureImage.update({ where: { id: existing.id }, data: payload }) : await app.prisma.figureImage.create({ data: payload });
  return { image, created: !existing };
}
async function processAndStoreImage(imageUrl, janCode, options) {
  const { alt, sortOrder = 0, isNsfw = false } = options || {};
  const { buffer } = await downloadImage(imageUrl);
  const sha256 = computeSha256(buffer);
  const dir = getImageDir(janCode);
  fs.mkdirSync(dir, { recursive: true });
  const metadata = await sharp(buffer).metadata();
  const originalWidth = metadata.width || 0;
  const results = [];
  for (const [sizeName, config] of Object.entries(IMAGE_SIZES)) {
    const filePath = getImageFilePath(janCode, sha256, sizeName);
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const existingMeta = await sharp(filePath).metadata();
      results.push({
        janCode,
        sha256,
        size: sizeName,
        format: "webp",
        width: existingMeta.width || null,
        height: existingMeta.height || null,
        fileSize: stat.size,
        source: imageUrl,
        alt,
        sortOrder,
        isNsfw
      });
      continue;
    }
    let pipeline = sharp(buffer).webp({ quality: config.quality });
    if (config.width !== null && originalWidth > config.width) {
      pipeline = pipeline.resize({ width: config.width, withoutEnlargement: true });
    }
    const outputBuffer = await pipeline.toBuffer();
    const outputMeta = await sharp(outputBuffer).metadata();
    fs.writeFileSync(filePath, outputBuffer);
    results.push({
      janCode,
      sha256,
      size: sizeName,
      format: "webp",
      width: outputMeta.width || null,
      height: outputMeta.height || null,
      fileSize: outputBuffer.length,
      source: imageUrl,
      alt,
      sortOrder,
      isNsfw
    });
  }
  return results;
}
var uploadSchema = z.object({
  url: z.string().url(),
  figureId: z.number().int().optional(),
  janCode: z.string().optional(),
  alt: z.string().optional(),
  sortOrder: z.number().int().optional()
});
var proxyQuerySchema = z.object({
  url: z.string().url()
});
var registerSchema = z.object({
  figureId: z.number().int(),
  janCode: z.string().optional(),
  sha256: z.string(),
  size: z.enum(["raw", "detail", "thumb"]),
  format: z.string().default("webp"),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  fileSize: z.number().int().nullable().optional(),
  alt: z.string().optional(),
  sortOrder: z.number().int().optional(),
  source: z.string().optional(),
  isNsfw: z.boolean().optional(),
  data: z.any().optional()
});
var processedUploadSchema = registerSchema.extend({
  contentBase64: z.string().min(1)
});
async function resolveStorageJanCode(app, figureId, janCode) {
  if (janCode) return janCode;
  const figure = await app.prisma.figure.findUnique({
    where: { id: BigInt(figureId) },
    select: { janCode: true }
  });
  return figure?.janCode || "no-jancode";
}
async function invalidateFigureImageCaches(app) {
  const detailKeys = await app.redis.keys("figures:detail:*");
  if (detailKeys.length > 0) await app.redis.del(...detailKeys);
  const listKeys = await app.redis.keys("figures:list:*");
  if (listKeys.length > 0) await app.redis.del(...listKeys);
}
async function imageRoutes(app) {
  app.post("/register", async (req, reply) => {
    const data = registerSchema.parse(req.body);
    try {
      const janCode = await resolveStorageJanCode(app, data.figureId, data.janCode);
      const { image, created } = await upsertFigureImageRecord(app, {
        figureId: BigInt(data.figureId),
        janCode,
        sha256: data.sha256,
        size: data.size,
        format: data.format || "webp",
        width: data.width ?? null,
        height: data.height ?? null,
        fileSize: data.fileSize ?? null,
        alt: data.alt || null,
        sortOrder: data.sortOrder ?? 0,
        source: data.source || null,
        isNsfw: data.isNsfw || false
      });
      await invalidateFigureImageCaches(app);
      return reply.status(created ? 201 : 200).send({
        success: true,
        data: {
          id: Number(image.id),
          apiUrl: `/api/v1/figures/images/${image.id}`,
          janCode,
          sha256: data.sha256,
          size: data.size,
          updated: !created
        }
      });
    } catch (err) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "IMAGE_REGISTER_FAILED",
          message: err.message || "Failed to register image metadata"
        }
      });
    }
  });
  app.post("/upload-processed", async (req, reply) => {
    const data = processedUploadSchema.parse(req.body);
    try {
      const janCode = await resolveStorageJanCode(app, data.figureId, data.janCode);
      const buffer = Buffer.from(data.contentBase64, "base64");
      if (!buffer.length) {
        return reply.status(422).send({
          success: false,
          error: { code: "EMPTY_IMAGE", message: "contentBase64 decoded to an empty file" }
        });
      }
      const filePath = getImageFilePath(janCode, data.sha256, data.size);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buffer);
      const payload = {
        figureId: BigInt(data.figureId),
        janCode,
        sha256: data.sha256,
        size: data.size,
        format: data.format || "webp",
        width: data.width ?? null,
        height: data.height ?? null,
        fileSize: data.fileSize || buffer.length,
        alt: data.alt || null,
        sortOrder: data.sortOrder ?? 0,
        source: data.source || null,
        isNsfw: data.isNsfw || false,
        data: data.data || null
      };
      const { image, created } = await upsertFigureImageRecord(app, payload);
      await invalidateFigureImageCaches(app);
      return reply.status(created ? 201 : 200).send({
        success: true,
        data: {
          id: Number(image.id),
          apiUrl: `/api/v1/figures/images/${image.id}`,
          janCode,
          sha256: data.sha256,
          size: data.size,
          fileSize: payload.fileSize,
          updated: !created
        }
      });
    } catch (err) {
      req.log.error({ err }, "Processed image upload failed");
      return reply.status(422).send({
        success: false,
        error: {
          code: "PROCESSED_IMAGE_UPLOAD_FAILED",
          message: err.message || "Failed to upload processed image"
        }
      });
    }
  });
  app.post("/upload", async (req, reply) => {
    const { url, figureId, janCode, alt, sortOrder } = uploadSchema.parse(req.body);
    if (!janCode && !figureId) {
      return reply.status(400).send({
        success: false,
        error: {
          code: "MISSING_IDENTIFIER",
          message: "Either janCode or figureId must be provided"
        }
      });
    }
    try {
      let resolvedJanCode = janCode || "";
      if (!resolvedJanCode && figureId) {
        const figure = await app.prisma.figure.findUnique({
          where: { id: BigInt(figureId) },
          select: { janCode: true }
        });
        if (figure) {
          resolvedJanCode = figure.janCode || "";
        }
      }
      if (!resolvedJanCode) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "MISSING_JAN_CODE",
            message: "Could not resolve janCode for image storage"
          }
        });
      }
      const imageRecords = await processAndStoreImage(url, resolvedJanCode, {
        alt,
        sortOrder
      });
      if (figureId) {
        let createdCount = 0;
        for (const rec of imageRecords) {
          const result = await upsertFigureImageRecord(app, {
            figureId: BigInt(figureId),
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
            isNsfw: rec.isNsfw || false
          });
          if (result.created) createdCount += 1;
        }
        return reply.status(201).send({
          success: true,
          data: {
            count: createdCount,
            janCode: resolvedJanCode,
            sha256: imageRecords[0].sha256,
            sizes: imageRecords.map((r) => ({
              size: r.size,
              width: r.width,
              height: r.height,
              fileSize: r.fileSize
            })),
            originalUrl: url,
            figureId
          }
        });
      }
      return reply.status(200).send({
        success: true,
        data: {
          janCode: resolvedJanCode,
          sha256: imageRecords[0].sha256,
          sizes: imageRecords.map((r) => ({
            size: r.size,
            width: r.width,
            height: r.height,
            fileSize: r.fileSize
          })),
          originalUrl: url,
          message: "Image processed and saved to disk. Use with figure creation to store in DB."
        }
      });
    } catch (err) {
      req.log.error({ err, url }, "Image upload failed");
      return reply.status(422).send({
        success: false,
        error: {
          code: "IMAGE_PROCESSING_FAILED",
          message: err.message || "Failed to process image"
        }
      });
    }
  });
  app.get("/proxy", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (req, reply) => {
    const { url } = proxyQuerySchema.parse(req.query);
    const urlCheck = await validateImageUrl(url);
    if (!urlCheck.ok) {
      return reply.status(422).send({
        success: false,
        error: { code: "URL_BLOCKED", message: urlCheck.reason || "URL not allowed" }
      });
    }
    try {
      const result = await downloadImage(url);
      const webpBuffer = await sharp(result.buffer).webp({ quality: 85 }).toBuffer();
      reply.header("Content-Type", "image/webp");
      reply.header("Content-Length", webpBuffer.length);
      reply.header("Cache-Control", "public, max-age=86400");
      reply.header("Access-Control-Allow-Origin", "*");
      return reply.send(webpBuffer);
    } catch (err) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "IMAGE_DOWNLOAD_FAILED",
          message: err.message || "Failed to download image"
        }
      });
    }
  });
  app.get("/:id", async (req, reply) => {
    const id = safeBigInt(req.params.id);
    if (id === null) {
      return reply.status(400).send({ success: false, error: { code: "INVALID_ID", message: "Invalid image ID" } });
    }
    const image = await app.prisma.figureImage.findUnique({
      where: { id },
      select: { janCode: true, sha256: true, size: true, format: true, fileSize: true, source: true, url: true }
    });
    if (!image) {
      return reply.status(404).send({ success: false, error: { code: "IMAGE_NOT_FOUND" } });
    }
    if (image.sha256 && image.janCode) {
      const filePath = getImageFilePath(image.janCode, image.sha256, image.size);
      if (fs.existsSync(filePath)) {
        reply.header("Content-Type", "image/webp");
        reply.header("Content-Length", image.fileSize || void 0);
        reply.header("Cache-Control", "public, max-age=2592000, immutable");
        reply.header("Access-Control-Allow-Origin", "*");
        const stream = fs.createReadStream(filePath);
        return reply.send(stream);
      }
    }
    const legacyUrl = image.url || (image.source && image.source.startsWith("http") ? image.source : null);
    if (legacyUrl) {
      try {
        const result = await downloadImage(legacyUrl);
        reply.header("Content-Type", result.contentType || "image/jpeg");
        reply.header("Cache-Control", "public, max-age=86400");
        reply.header("Access-Control-Allow-Origin", "*");
        return reply.send(result.buffer);
      } catch {
        const urlCheck = await validateImageUrl(legacyUrl);
        if (!urlCheck.ok) {
          return reply.status(422).send({ success: false, error: { code: "URL_BLOCKED", message: urlCheck.reason || "URL not allowed for redirect" } });
        }
        reply.code(302);
        reply.header("location", legacyUrl);
        return reply.send();
      }
    }
    return reply.status(404).send({ success: false, error: { code: "IMAGE_NOT_FOUND" } });
  });
}

// src/routes/figures.ts
var listQuery = z2.object({
  page: z2.coerce.number().min(1).default(1),
  perPage: z2.coerce.number().min(1).max(100).default(24),
  sort: z2.enum(["release_date:desc", "release_date:asc", "price_jpy:asc", "price_jpy:desc", "name:asc", "name:desc", "created_at:desc", "popularity:desc"]).default("release_date:desc"),
  series: z2.string().optional(),
  manufacturer: z2.string().optional(),
  sculptor: z2.string().optional(),
  category: z2.string().optional(),
  scale: z2.string().optional(),
  year: z2.coerce.number().optional(),
  minPrice: z2.coerce.number().optional(),
  maxPrice: z2.coerce.number().optional(),
  priceMin: z2.coerce.number().optional(),
  priceMax: z2.coerce.number().optional(),
  search: z2.string().optional(),
  lang: z2.string().optional()
});
var detailQuery = z2.object({
  lang: z2.string().optional()
});
var localizedSchema = z2.object({
  language: z2.string().min(1),
  title: z2.string().optional(),
  origin: z2.string().optional(),
  character: z2.string().optional(),
  description: z2.string().optional()
});
var releaseSchema = z2.object({
  edition: z2.string().min(1),
  releaseDate: z2.string().optional().nullable(),
  priceJpy: z2.number().int().optional().nullable(),
  isRerelease: z2.boolean().optional()
});
var imageInputSchema = z2.object({
  source: z2.string().min(1),
  alt: z2.string().optional(),
  sortOrder: z2.number().int().optional()
});
var createFigureSchema = z2.object({
  slug: z2.string().min(1),
  name: z2.string().min(1),
  nameJp: z2.string().optional(),
  nameEn: z2.string().optional(),
  scale: z2.string().optional(),
  material: z2.string().optional(),
  priceJpy: z2.number().int().optional(),
  releaseDate: z2.string().optional(),
  heightMm: z2.number().int().optional(),
  weightG: z2.number().int().optional(),
  janCode: z2.string().optional(),
  mfcId: z2.string().optional(),
  amiamiId: z2.string().optional(),
  hljId: z2.string().optional(),
  hobbySearchId: z2.string().optional(),
  productLine: z2.string().optional(),
  ageRating: z2.string().optional(),
  parentId: z2.number().int().optional(),
  seriesId: z2.number().int().optional(),
  manufacturerId: z2.number().int().optional(),
  categoryIds: z2.array(z2.number().int()).optional(),
  sculptorIds: z2.array(z2.object({ id: z2.number().int(), role: z2.string().optional(), isPrimary: z2.boolean().optional() })).optional(),
  characterIds: z2.array(z2.object({ id: z2.number().int(), isFeatured: z2.boolean().optional() })).optional(),
  localized: z2.array(localizedSchema).optional(),
  releases: z2.array(releaseSchema).optional(),
  images: z2.array(imageInputSchema).optional()
});
var updateFigureSchema = z2.object({
  slug: z2.string().min(1).optional(),
  name: z2.string().min(1).optional(),
  nameJp: z2.string().optional().nullable(),
  nameEn: z2.string().optional().nullable(),
  scale: z2.string().optional().nullable(),
  material: z2.string().optional().nullable(),
  priceJpy: z2.number().int().optional().nullable(),
  releaseDate: z2.string().optional().nullable(),
  heightMm: z2.number().int().optional().nullable(),
  weightG: z2.number().int().optional().nullable(),
  janCode: z2.string().optional().nullable(),
  productLine: z2.string().optional().nullable(),
  ageRating: z2.string().optional().nullable(),
  parentId: z2.number().int().optional().nullable(),
  seriesId: z2.number().int().optional().nullable(),
  manufacturerId: z2.number().int().optional().nullable(),
  categoryIds: z2.array(z2.number().int()).optional(),
  sculptorIds: z2.array(z2.object({ id: z2.number().int(), role: z2.string().optional(), isPrimary: z2.boolean().optional() })).optional(),
  characterIds: z2.array(z2.object({ id: z2.number().int(), isFeatured: z2.boolean().optional() })).optional(),
  localized: z2.array(localizedSchema).optional(),
  releases: z2.array(releaseSchema).optional(),
  images: z2.array(imageInputSchema).optional()
});
function buildImageUrl(imageId) {
  return `/api/v1/figures/images/${imageId}`;
}
function publicSlug(slug) {
  return String(slug || "").replace(/-+$/g, "");
}
function isSafeDisplayImage(image) {
  if (!image) return false;
  const w = Number(image.width) || 0;
  const h = Number(image.height) || 0;
  const source = String(image.source || image.url || "");
  const metaData = image.data || {};
  const sourceKind = String(metaData.source_kind || "");
  const safeDisplay = metaData.safe_display === true;
  if (source.includes("myfigurecollection.net/upload/pictures/")) {
    return (sourceKind === "official_item_image" || sourceKind === "mfc_review_approved") && safeDisplay;
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
function imagePixels(image) {
  return (Number(image?.width) || 0) * (Number(image?.height) || 0);
}
function pickImageVariant(images, preferredSizes) {
  if (!images || images.length === 0) return null;
  for (const size of preferredSizes) {
    const candidates = images.filter((img) => img.size === size);
    if (candidates.length > 0) {
      return candidates.sort((a, b) => imagePixels(b) - imagePixels(a) || Number(a.id) - Number(b.id))[0];
    }
  }
  return [...images].sort((a, b) => imagePixels(b) - imagePixels(a) || Number(a.id) - Number(b.id))[0];
}
function imageGroupPriority(group) {
  const sample = group[0] || {};
  const source = String(sample.source || sample.url || "");
  const metaData = sample.data || {};
  const lowQ = metaData.image_low_quality === true;
  const kind = String(metaData.source_kind || "");
  if (kind === "mfc_review_approved") return 10;
  if (lowQ && kind === "official_item_thumbnail") return 100;
  if (source.includes("myfigurecollection.net")) return 50;
  return 0;
}
function groupImageVariants(images) {
  if (!images || images.length === 0) return [];
  const groups = /* @__PURE__ */ new Map();
  for (const image of images) {
    const source = image.source || image.url || "";
    const key = source ? `source:${String(source).trim()}` : image.sha256 ? `sha:${image.sha256}` : `id:${image.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(image);
  }
  return [...groups.values()].sort((a, b) => {
    const aPri = imageGroupPriority(a);
    const bPri = imageGroupPriority(b);
    if (aPri !== bPri) return aPri - bPri;
    const aMaxPixels = Math.max(...a.map(imagePixels));
    const bMaxPixels = Math.max(...b.map(imagePixels));
    if (aMaxPixels !== bMaxPixels) return bMaxPixels - aMaxPixels;
    const aMinSort = Math.min(...a.map((img) => Number(img.sortOrder) || 0));
    const bMinSort = Math.min(...b.map((img) => Number(img.sortOrder) || 0));
    const aMinId = Math.min(...a.map((img) => Number(img.id) || 0));
    const bMinId = Math.min(...b.map((img) => Number(img.id) || 0));
    return aMinSort - bMinSort || aMinId - bMinId;
  }).map((group) => {
    const safeGroup = group.filter((img) => isSafeDisplayImage(img));
    if (safeGroup.length === 0) return null;
    const display = pickImageVariant(safeGroup, ["detail", "raw", "thumb"]);
    const raw = pickImageVariant(safeGroup, ["raw", "detail", "thumb"]);
    const thumb = pickImageVariant(safeGroup, ["thumb", "detail", "raw"]);
    const variants = {};
    for (const image of group) {
      if (image.size && !variants[image.size]) variants[image.size] = buildImageUrl(image.id);
    }
    return {
      ...display,
      url: buildImageUrl(display.id),
      thumbnailUrl: buildImageUrl(thumb.id),
      fullUrl: buildImageUrl(raw.id),
      variants,
      variantIds: Object.fromEntries(group.map((image) => [image.size || String(image.id), Number(image.id)]))
    };
  }).filter((g) => g !== null);
}
function publicImage(image) {
  if (!image) return image;
  const { source, janCode, sha256, fileSize, data, ...rest } = image;
  const metaData = data || {};
  return {
    ...rest,
    sourceKind: String(metaData.source_kind || ""),
    safeDisplay: metaData.safe_display === true,
    imageLowQuality: metaData.image_low_quality === true
  };
}
function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
function publicEntityName(entity) {
  return firstText(entity?.nameEn, entity?.name, entity?.nameJp);
}
function publicFigure(figure) {
  if (!figure) return figure;
  const originalImage = figure.image;
  const originalImages = figure.images;
  const localized = Array.isArray(figure.localized) ? figure.localized[0] : null;
  const featuredCharacter = Array.isArray(figure.characters) ? figure.characters.find((item) => item?.isFeatured)?.character || figure.characters[0]?.character : null;
  const displayTitle = firstText(localized?.title, figure.nameEn, figure.name, figure.nameJp, figure.slug) || "";
  const originalTitle = firstText(figure.nameJp, figure.name, figure.nameEn, displayTitle) || displayTitle;
  const displayOrigin = firstText(localized?.origin, publicEntityName(figure.series));
  const displayCharacter = firstText(localized?.character, publicEntityName(featuredCharacter));
  const displayDescription = firstText(localized?.description, figure.description);
  const rest = { ...figure };
  const hiddenKeys = [
    String.fromCharCode(109, 102, 99, 73, 100),
    String.fromCharCode(97, 109, 105, 97, 109, 105, 73, 100),
    String.fromCharCode(104, 111, 98, 98, 121, 83, 101, 97, 114, 99, 104, 73, 100),
    String.fromCharCode(104, 108, 106, 73, 100),
    "images",
    "image"
  ];
  hiddenKeys.forEach((key) => delete rest[key]);
  return {
    ...rest,
    slug: publicSlug(figure.slug),
    displayTitle,
    originalTitle,
    displayOrigin,
    displayCharacter,
    displayDescription,
    image: originalImage ? publicImage(originalImage) : originalImage,
    images: Array.isArray(originalImages) ? originalImages.map(publicImage) : originalImages
  };
}
function sourceSlugFallbacks(slug) {
  return [{ slug }];
}
async function invalidateFigureCache(app, slug) {
  if (slug) {
    await app.redis.del(`figures:detail:${slug}`);
  }
  await scanKeys(app.redis, "figures:detail:*");
  await scanKeys(app.redis, "figures:list:*");
}
async function figureRoutes(app) {
  app.get("/", async (req) => {
    const raw = listQuery.parse(req.query);
    const query = { ...raw, lang: raw.lang || "fr", minPrice: raw.minPrice ?? raw.priceMin, maxPrice: raw.maxPrice ?? raw.priceMax };
    const cacheKey = `figures:list:${JSON.stringify(query)}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const where = { isDeleted: false };
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: "insensitive" } },
        { nameJp: { contains: query.search, mode: "insensitive" } },
        { nameEn: { contains: query.search, mode: "insensitive" } },
        { janCode: { contains: query.search, mode: "insensitive" } }
      ];
    }
    if (query.series) where.series = { slug: query.series };
    if (query.manufacturer) where.manufacturer = { slug: query.manufacturer };
    if (query.scale) where.scale = query.scale;
    if (query.year) where.releaseDate = { gte: /* @__PURE__ */ new Date(`${query.year}-01-01`), lt: /* @__PURE__ */ new Date(`${query.year + 1}-01-01`) };
    if (query.minPrice || query.maxPrice) {
      where.priceJpy = {};
      if (query.minPrice) where.priceJpy.gte = query.minPrice;
      if (query.maxPrice) where.priceJpy.lte = query.maxPrice;
    }
    if (query.category) where.categories = { some: { category: { slug: query.category } } };
    if (query.sculptor) where.sculptors = { some: { sculptor: { slug: query.sculptor } } };
    const [orderBy, orderDir] = query.sort.split(":");
    const orderField = { release_date: "releaseDate", price_jpy: "priceJpy", name: "name", created_at: "createdAt", popularity: "createdAt" }[orderBy] || "createdAt";
    const stableOrderBy = [{ [orderField]: orderDir }, { id: orderDir === "asc" ? "asc" : "desc" }];
    const [data, total] = await Promise.all([
      app.prisma.figure.findMany({
        where,
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: stableOrderBy,
        include: {
          manufacturer: { select: { id: true, slug: true, name: true, nameEn: true } },
          series: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true } },
          characters: { include: { character: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true } } } },
          sculptors: { include: { sculptor: { select: { id: true, slug: true, name: true, nameEn: true } } } },
          categories: { include: { category: { select: { id: true, slug: true, name: true } } } },
          localized: {
            where: { language: query.lang },
            orderBy: { id: "asc" }
          },
          images: {
            orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
            take: 12,
            select: {
              id: true,
              alt: true,
              size: true,
              format: true,
              sha256: true,
              width: true,
              height: true,
              blurhash: true,
              sortOrder: true,
              source: true,
              data: true
            }
          },
          releases: {
            orderBy: { releaseDate: "asc" },
            take: 1,
            select: { id: true, edition: true, releaseDate: true, priceJpy: true, isRerelease: true }
          }
        }
      }),
      app.prisma.figure.count({ where })
    ]);
    const transformed = data.map((fig) => {
      const imageGroups = groupImageVariants(fig.images || []);
      const bestImage = imageGroups[0] || null;
      const firstRelease = fig.releases?.[0] || null;
      return publicFigure({
        ...fig,
        image: bestImage,
        images: bestImage ? [bestImage] : [],
        firstRelease,
        releases: void 0
      });
    });
    const result = {
      success: true,
      data: transformed,
      meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) }
    };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 300);
    return result;
  });
  app.get("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const rawQuery = detailQuery.parse(req.query || {});
    const lang = rawQuery.lang || "fr";
    const cacheKey = `figures:detail:${slug}:${lang}`;
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
          where: { language: lang },
          orderBy: { id: "asc" }
        },
        releases: {
          orderBy: { releaseDate: "asc" }
        },
        images: {
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
          select: {
            id: true,
            alt: true,
            size: true,
            format: true,
            sha256: true,
            width: true,
            height: true,
            blurhash: true,
            fileSize: true,
            sortOrder: true,
            source: true,
            data: true,
            isNsfw: true,
            janCode: true
          }
        },
        revisions: { where: { isActive: true }, take: 1 }
      }
    });
    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND", message: "Figure not found" } });
    const transformedImages = groupImageVariants(figure.images || []);
    const mainImage = transformedImages[0] || null;
    let lineage = null;
    const descendants = await app.prisma.figure.findMany({
      where: { parentId: figure.id, isDeleted: false },
      select: { id: true, slug: true, name: true, releaseDate: true }
    });
    const ancestors = [];
    if (figure.parentId) {
      let cur = figure;
      while (cur.parentId) {
        const p = await app.prisma.figure.findFirst({
          where: { id: cur.parentId, isDeleted: false },
          select: { id: true, slug: true, name: true, releaseDate: true, parentId: true }
        });
        if (p) {
          ancestors.unshift(p);
          cur = p;
        } else break;
      }
    }
    lineage = { ancestors, descendants };
    const result = { success: true, data: publicFigure({ ...figure, image: mainImage, images: transformedImages, lineage }) };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
    return result;
  });
  app.get("/:slug/lineage", async (req, reply) => {
    const { slug } = req.params;
    const figure = await app.prisma.figure.findFirst({ where: { slug, isDeleted: false }, select: { id: true, slug: true, name: true, releaseDate: true } });
    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });
    const ancestors = [];
    let current = await app.prisma.figure.findFirst({ where: { id: figure.id, isDeleted: false }, select: { parentId: true } });
    while (current?.parentId) {
      const parent = await app.prisma.figure.findFirst({
        where: { id: current.parentId, isDeleted: false },
        select: { id: true, slug: true, name: true, releaseDate: true, parentId: true }
      });
      if (parent) {
        ancestors.unshift(parent);
        current = parent;
      } else break;
    }
    const descendants = await app.prisma.figure.findMany({
      where: { parentId: figure.id, isDeleted: false },
      select: { id: true, slug: true, name: true, releaseDate: true }
    });
    return { success: true, data: { current: figure, ancestors, descendants } };
  });
  app.get("/:slug/revisions", async (req, reply) => {
    const { slug } = req.params;
    const figure = await app.prisma.figure.findFirst({ where: { slug, isDeleted: false }, select: { id: true } });
    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });
    const revisions = await app.prisma.revision.findMany({
      where: { figureId: figure.id },
      select: { id: true, versionNumber: true, editSummary: true, editorId: true, isActive: true, createdAt: true },
      orderBy: { versionNumber: "desc" }
    });
    return { success: true, data: revisions };
  });
  app.post("/", async (req, reply) => {
    const data = createFigureSchema.parse(req.body);
    const { categoryIds, sculptorIds, characterIds, images, localized, releases, releaseDate, ...figureData } = data;
    const figure = await app.prisma.figure.create({
      data: {
        ...figureData,
        releaseDate: releaseDate ? new Date(releaseDate) : void 0,
        categories: { create: categoryIds?.map((categoryId) => ({ category: { connect: { id: categoryId } } })) || [] },
        sculptors: { create: sculptorIds?.map((s) => ({ sculptor: { connect: { id: s.id } }, role: s.role, isPrimary: s.isPrimary ?? false })) || [] },
        characters: { create: characterIds?.map((c) => ({ character: { connect: { id: c.id } }, isFeatured: c.isFeatured ?? false })) || [] },
        localized: { create: localized?.map((loc) => ({ language: loc.language, title: loc.title, origin: loc.origin, character: loc.character, description: loc.description })) || [] },
        releases: { create: releases?.map((rel) => ({ edition: rel.edition, releaseDate: rel.releaseDate ? new Date(rel.releaseDate) : void 0, priceJpy: rel.priceJpy ?? void 0, isRerelease: rel.isRerelease ?? false })) || [] }
      }
    });
    const imageImport = { created: 0, errors: [] };
    if (images && images.length > 0) {
      const janCode = figureData.janCode || figure.janCode || "no-jancode";
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        try {
          const imageRecords = await processAndStoreImage(img.source, janCode, {
            alt: img.alt,
            sortOrder: img.sortOrder ?? i
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
              isNsfw: rec.isNsfw || false
            });
            if (result.created) imageImport.created += 1;
          }
        } catch (err) {
          app.log.error({ err, source: img.source }, "Failed to process image during figure creation");
          imageImport.errors.push({ source: img.source, error: err?.message || "Image processing failed" });
        }
      }
    }
    await invalidateFigureCache(app);
    return reply.status(201).send({ success: true, data: figure, meta: { imageImport } });
  });
  app.put("/:slug", async (req, reply) => {
    const { slug } = req.params;
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
    const updateData = {
      ...figureData,
      releaseDate: releaseDate !== void 0 ? releaseDate ? new Date(releaseDate) : null : void 0
    };
    for (const [key, value] of Object.entries(figureData)) {
      if (value === null) {
        updateData[key] = null;
      }
    }
    if (categoryIds !== void 0) {
      updateData.categories = {
        deleteMany: {},
        create: categoryIds.map((categoryId) => ({ category: { connect: { id: categoryId } } }))
      };
    }
    if (sculptorIds !== void 0) {
      updateData.sculptors = {
        deleteMany: {},
        create: sculptorIds.map((s) => ({ sculptor: { connect: { id: s.id } }, role: s.role, isPrimary: s.isPrimary ?? false }))
      };
    }
    if (characterIds !== void 0) {
      updateData.characters = {
        deleteMany: {},
        create: characterIds.map((c) => ({ character: { connect: { id: c.id } }, isFeatured: c.isFeatured ?? false }))
      };
    }
    if (localized !== void 0) {
      updateData.localized = {
        deleteMany: {},
        create: localized.map((loc) => ({
          language: loc.language,
          title: loc.title,
          origin: loc.origin,
          character: loc.character,
          description: loc.description
        }))
      };
    }
    if (releases !== void 0) {
      updateData.releases = {
        deleteMany: {},
        create: releases.map((rel) => ({
          edition: rel.edition,
          releaseDate: rel.releaseDate ? new Date(rel.releaseDate) : void 0,
          priceJpy: rel.priceJpy ?? void 0,
          isRerelease: rel.isRerelease ?? false
        }))
      };
    }
    const figure = await app.prisma.figure.update({
      where: { slug },
      data: updateData
    });
    const imageImport = { created: 0, errors: [] };
    if (images && images.length > 0) {
      const janCode = (figureData.janCode ?? existing.janCode) || "no-jancode";
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        try {
          const imageRecords = await processAndStoreImage(img.source, janCode, {
            alt: img.alt,
            sortOrder: img.sortOrder ?? i
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
              isNsfw: rec.isNsfw || false
            });
            if (result.created) imageImport.created += 1;
          }
        } catch (err) {
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
  app.delete("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const existing = await app.prisma.figure.findFirst({ where: { slug, isDeleted: false } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });
    await app.prisma.figure.update({ where: { slug }, data: { isDeleted: true } });
    await invalidateFigureCache(app, slug);
    return { success: true, data: { deleted: true } };
  });
}

// src/routes/search.ts
import { z as z3 } from "zod";
var searchQuery = z3.object({
  q: z3.string().min(1).max(200),
  type: z3.enum(["all", "figure", "series", "manufacturer", "sculptor", "character"]).default("all"),
  lang: z3.string().optional(),
  locale: z3.string().optional(),
  page: z3.coerce.number().min(1).default(1),
  perPage: z3.coerce.number().min(1).max(100).default(12)
});
var SEARCH_LIMIT = 30;
function publicSlug2(slug) {
  return String(slug || "").replace(/-+$/g, "");
}
function normalizeLang(value) {
  const lang = String(value || "fr").trim().toLowerCase().split(/[-_]/)[0];
  return lang || "fr";
}
function firstText2(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
function publicEntityName2(entity) {
  return firstText2(entity?.nameEn, entity?.name, entity?.nameJp);
}
async function searchRoutes(app) {
  app.get("/", async (req, reply) => {
    const query = searchQuery.parse(req.query);
    const searchTerm = query.q;
    const resultType = query.type;
    const lang = normalizeLang(query.lang || query.locale);
    const textFilter = { contains: searchTerm, mode: "insensitive" };
    const whereCondition = {
      OR: [
        { name: textFilter },
        { nameJp: textFilter },
        { nameEn: textFilter }
      ]
    };
    const figureSelect = {
      id: true,
      slug: true,
      name: true,
      nameJp: true,
      nameEn: true,
      description: true,
      priceJpy: true,
      releaseDate: true,
      scale: true,
      manufacturer: { select: { id: true, slug: true, name: true, nameEn: true } },
      series: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true } },
      characters: { include: { character: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true } } } },
      localized: {
        where: { language: lang },
        orderBy: { id: "asc" }
      },
      images: {
        orderBy: { sortOrder: "asc" },
        take: 3,
        select: {
          id: true,
          url: true,
          alt: true,
          size: true,
          format: true,
          width: true,
          height: true,
          sortOrder: true,
          source: true,
          data: true
        }
      },
      categories: { include: { category: { select: { slug: true, name: true } } } }
    };
    const characterSelect = {
      id: true,
      slug: true,
      name: true,
      nameJp: true,
      nameEn: true,
      series: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true } },
      _count: { select: { figures: true } }
    };
    function isSafeDisplayImage3(image) {
      if (!image) return false;
      const w = Number(image.width) || 0;
      const h = Number(image.height) || 0;
      const source = String(image.source || image.url || "");
      const metaData = image.data || {};
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
    function normalizeFigureImages(figures) {
      return figures.map((fig) => {
        const localized = Array.isArray(fig.localized) ? fig.localized[0] : null;
        const featuredCharacter = Array.isArray(fig.characters) ? fig.characters.find((item) => item?.isFeatured)?.character || fig.characters[0]?.character : null;
        const displayTitle = firstText2(localized?.title, fig.nameEn, fig.name, fig.nameJp, fig.slug) || "";
        const originalTitle = firstText2(fig.nameJp, fig.name, fig.nameEn, displayTitle) || displayTitle;
        const displayOrigin = firstText2(localized?.origin, publicEntityName2(fig.series));
        const displayCharacter = firstText2(localized?.character, publicEntityName2(featuredCharacter));
        const displayDescription = firstText2(localized?.description, fig.description);
        return {
          ...fig,
          slug: publicSlug2(fig.slug),
          displayTitle,
          originalTitle,
          displayOrigin,
          displayCharacter,
          displayDescription,
          images: (fig.images || []).filter((img) => isSafeDisplayImage3(img)).map((img) => ({
            ...img,
            url: `/api/v1/figures/images/${img.id}`
          }))
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
          orderBy: { releaseDate: "desc" }
        }),
        app.prisma.figure.count({ where: { ...whereCondition, ...whereDeleted } })
      ]);
      result = {
        figures: { items: normalizeFigureImages(items), total },
        series: { items: [], total: 0 },
        manufacturers: { items: [], total: 0 },
        sculptors: { items: [], total: 0 },
        characters: { items: [], total: 0 },
        meta: { totalResults: total, figuresCount: total, seriesCount: 0, manufacturersCount: 0, sculptorsCount: 0, charactersCount: 0 }
      };
    } else if (resultType === "series") {
      const [items, total] = await Promise.all([
        app.prisma.series.findMany({
          where: whereCondition,
          select: { id: true, slug: true, name: true, nameJp: true, nameEn: true, _count: { select: { figures: true } } },
          take: SEARCH_LIMIT
        }),
        app.prisma.series.count({ where: whereCondition })
      ]);
      result = {
        figures: { items: [], total: 0 },
        series: { items, total },
        manufacturers: { items: [], total: 0 },
        sculptors: { items: [], total: 0 },
        characters: { items: [], total: 0 },
        meta: { totalResults: total, figuresCount: 0, seriesCount: total, manufacturersCount: 0, sculptorsCount: 0, charactersCount: 0 }
      };
    } else if (resultType === "manufacturer") {
      const [items, total] = await Promise.all([
        app.prisma.manufacturer.findMany({
          where: whereCondition,
          select: { id: true, slug: true, name: true, nameJp: true, nameEn: true, country: true, _count: { select: { figures: true } } },
          take: SEARCH_LIMIT
        }),
        app.prisma.manufacturer.count({ where: whereCondition })
      ]);
      result = {
        figures: { items: [], total: 0 },
        series: { items: [], total: 0 },
        manufacturers: { items, total },
        sculptors: { items: [], total: 0 },
        characters: { items: [], total: 0 },
        meta: { totalResults: total, figuresCount: 0, seriesCount: 0, manufacturersCount: total, sculptorsCount: 0, charactersCount: 0 }
      };
    } else if (resultType === "sculptor") {
      const [items, total] = await Promise.all([
        app.prisma.sculptor.findMany({
          where: whereCondition,
          select: { id: true, slug: true, name: true, nameJp: true, nameEn: true, _count: { select: { figures: true } } },
          take: SEARCH_LIMIT
        }),
        app.prisma.sculptor.count({ where: whereCondition })
      ]);
      result = {
        figures: { items: [], total: 0 },
        series: { items: [], total: 0 },
        manufacturers: { items: [], total: 0 },
        sculptors: { items, total },
        characters: { items: [], total: 0 },
        meta: { totalResults: total, figuresCount: 0, seriesCount: 0, manufacturersCount: 0, sculptorsCount: total, charactersCount: 0 }
      };
    } else if (resultType === "character") {
      const [items, total] = await Promise.all([
        app.prisma.character.findMany({
          where: whereCondition,
          select: characterSelect,
          take: SEARCH_LIMIT
        }),
        app.prisma.character.count({ where: whereCondition })
      ]);
      result = {
        figures: { items: [], total: 0 },
        series: { items: [], total: 0 },
        manufacturers: { items: [], total: 0 },
        sculptors: { items: [], total: 0 },
        characters: { items, total },
        meta: { totalResults: total, figuresCount: 0, seriesCount: 0, manufacturersCount: 0, sculptorsCount: 0, charactersCount: total }
      };
    } else {
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
        app.prisma.character.count({ where: whereCondition })
      ]);
      result = {
        figures: { items: normalizeFigureImages(figItems), total: figCount },
        series: { items: serItems, total: serCount },
        manufacturers: { items: mfrItems, total: mfrCount },
        sculptors: { items: scItems, total: scCount },
        characters: { items: charItems, total: charCount },
        meta: {
          totalResults: figCount + serCount + mfrCount + scCount + charCount,
          figuresCount: figCount,
          seriesCount: serCount,
          manufacturersCount: mfrCount,
          sculptorsCount: scCount,
          charactersCount: charCount
        }
      };
    }
    const { meta, ...data } = result;
    return { success: true, data, meta };
  });
}

// src/routes/categories.ts
import { z as z4 } from "zod";
var createCategorySchema = z4.object({
  slug: z4.string().min(1),
  name: z4.string().min(1),
  parentId: z4.coerce.bigint().optional(),
  sortOrder: z4.number().int().optional()
});
var updateCategorySchema = createCategorySchema.partial();
async function invalidateCategoryCache(app, slug) {
  if (slug) {
    await app.redis.del(`categories:detail:${slug}`);
  }
  await scanKeys(app.redis, "categories:*");
}
async function activeFigureCountByCategory(app, categoryIds) {
  if (!categoryIds.length) return /* @__PURE__ */ new Map();
  const rows = await app.prisma.figureCategory.groupBy({
    by: ["categoryId"],
    where: {
      categoryId: { in: categoryIds },
      figure: { isDeleted: false }
    },
    _count: { figureId: true }
  });
  return new Map(rows.map((row) => [String(row.categoryId), row._count.figureId || 0]));
}
function attachActiveCounts(category, counts) {
  return {
    ...category,
    _count: {
      ...category._count || {},
      figures: counts.get(String(category.id)) || 0
    },
    children: (category.children || []).map((child) => attachActiveCounts(child, counts))
  };
}
function collectCategoryIds(categories) {
  const ids = [];
  const visit = (category) => {
    ids.push(category.id);
    (category.children || []).forEach(visit);
  };
  categories.forEach(visit);
  return ids;
}
async function categoryRoutes(app) {
  app.get("/", async () => {
    const cacheKey = "categories:all";
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const categories = await app.prisma.category.findMany({
      where: { parentId: null },
      include: { children: { include: { children: true } } },
      orderBy: { sortOrder: "asc" }
    });
    const counts = await activeFigureCountByCategory(app, collectCategoryIds(categories));
    const categoriesWithCounts = categories.map((category) => attachActiveCounts(category, counts));
    const result = { success: true, data: JSON.parse(JSON.stringify(categoriesWithCounts)) };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 600);
    return result;
  });
  app.get("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const category = await app.prisma.category.findUnique({
      where: { slug },
      include: { parent: true, children: true }
    });
    if (!category) return reply.status(404).send({ success: false, error: { code: "CATEGORY_NOT_FOUND" } });
    const counts = await activeFigureCountByCategory(app, collectCategoryIds([category]));
    return { success: true, data: JSON.parse(JSON.stringify(attachActiveCounts(category, counts))) };
  });
  app.post("/", async (req, reply) => {
    const data = createCategorySchema.parse(req.body);
    const existing = await app.prisma.category.findUnique({ where: { slug: data.slug } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    const category = await app.prisma.category.create({ data });
    await invalidateCategoryCache(app);
    return reply.status(201).send({ success: true, data: JSON.parse(JSON.stringify(category)) });
  });
  app.put("/:slug", async (req, reply) => {
    const { slug } = req.params;
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
  app.delete("/:slug", async (req, reply) => {
    const { slug } = req.params;
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

// src/routes/series.ts
import { z as z5 } from "zod";
var listQuery2 = z5.object({
  page: z5.coerce.number().min(1).default(1),
  perPage: z5.coerce.number().min(1).max(100).default(50)
});
var createSeriesSchema = z5.object({
  slug: z5.string().min(1),
  name: z5.string().min(1),
  nameJp: z5.string().optional(),
  nameEn: z5.string().optional(),
  mediaType: z5.string().optional(),
  description: z5.string().optional()
});
var updateSeriesSchema = createSeriesSchema.partial();
async function invalidateSeriesCache(app, slug) {
  if (slug) {
    await app.redis.del(`series:detail:${slug}`);
  }
  await scanKeys(app.redis, "series:list:*");
}
async function seriesRoutes(app) {
  app.get("/", async (req) => {
    const query = listQuery2.parse(req.query);
    const cacheKey = `series:list:${query.page}:${query.perPage}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const [data, total] = await Promise.all([
      app.prisma.series.findMany({
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { name: "asc" },
        include: { _count: { select: { figures: true } } }
      }),
      app.prisma.series.count()
    ]);
    const result = { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 600);
    return result;
  });
  app.get("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const cacheKey = `series:detail:${slug}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const series = await app.prisma.series.findUnique({
      where: { slug },
      include: { _count: { select: { figures: true } } }
    });
    if (!series) return reply.status(404).send({ success: false, error: { code: "SERIES_NOT_FOUND" } });
    const result = { success: true, data: series };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
    return result;
  });
  app.get("/:slug/figures", async (req) => {
    const { slug } = req.params;
    const query = listQuery2.parse(req.query);
    const series = await app.prisma.series.findUnique({ where: { slug }, select: { id: true } });
    if (!series) return { success: true, data: [], meta: { page: 1, perPage: 24, total: 0, totalPages: 0 } };
    const [data, total] = await Promise.all([
      app.prisma.figure.findMany({
        where: { seriesId: series.id, isDeleted: false },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { releaseDate: "desc" },
        include: {
          manufacturer: { select: { id: true, slug: true, name: true, nameEn: true } },
          images: { orderBy: { sortOrder: "asc" }, take: 1, select: { id: true, alt: true, size: true, format: true } },
          categories: { include: { category: { select: { slug: true, name: true } } } }
        }
      }),
      app.prisma.figure.count({ where: { seriesId: series.id, isDeleted: false } })
    ]);
    return { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
  });
  app.post("/", async (req, reply) => {
    const data = createSeriesSchema.parse(req.body);
    const existing = await app.prisma.series.findUnique({ where: { slug: data.slug } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    const series = await app.prisma.series.create({ data });
    await invalidateSeriesCache(app);
    return reply.status(201).send({ success: true, data: series });
  });
  app.put("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const data = updateSeriesSchema.parse(req.body);
    const existing = await app.prisma.series.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "SERIES_NOT_FOUND" } });
    if (data.slug && data.slug !== slug) {
      const slugExists = await app.prisma.series.findUnique({ where: { slug: data.slug } });
      if (slugExists) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    }
    const series = await app.prisma.series.update({ where: { slug }, data });
    await invalidateSeriesCache(app, slug);
    if (data.slug && data.slug !== slug) await invalidateSeriesCache(app, data.slug);
    return { success: true, data: series };
  });
  app.delete("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const existing = await app.prisma.series.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "SERIES_NOT_FOUND" } });
    const figureCount = await app.prisma.figure.count({ where: { seriesId: existing.id } });
    if (figureCount > 0) return reply.status(409).send({ success: false, error: { code: "HAS_FIGURES", message: `Series has ${figureCount} figures, reassign them first` } });
    await app.prisma.series.delete({ where: { slug } });
    await invalidateSeriesCache(app, slug);
    return { success: true, data: { deleted: true } };
  });
}

// src/routes/manufacturer.ts
import { z as z6 } from "zod";
var listQuery3 = z6.object({
  page: z6.coerce.number().min(1).default(1),
  perPage: z6.coerce.number().min(1).max(100).default(50)
});
var createManufacturerSchema = z6.object({
  slug: z6.string().min(1),
  name: z6.string().min(1),
  nameJp: z6.string().optional(),
  nameEn: z6.string().optional(),
  country: z6.string().optional(),
  website: z6.string().optional(),
  description: z6.string().optional()
});
var updateManufacturerSchema = createManufacturerSchema.partial();
async function invalidateManufacturerCache(app, slug) {
  if (slug) {
    await app.redis.del(`manufacturers:detail:${slug}`);
  }
  await scanKeys(app.redis, "manufacturers:list:*");
}
async function manufacturerRoutes(app) {
  app.get("/", async (req) => {
    const query = listQuery3.parse(req.query);
    const cacheKey = `manufacturers:list:${query.page}:${query.perPage}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const [data, total] = await Promise.all([
      app.prisma.manufacturer.findMany({
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { name: "asc" },
        include: { _count: { select: { figures: true } } }
      }),
      app.prisma.manufacturer.count()
    ]);
    const result = { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 600);
    return result;
  });
  app.get("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const cacheKey = `manufacturers:detail:${slug}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const manufacturer = await app.prisma.manufacturer.findUnique({
      where: { slug },
      include: { _count: { select: { figures: true } } }
    });
    if (!manufacturer) return reply.status(404).send({ success: false, error: { code: "MANUFACTURER_NOT_FOUND" } });
    const result = { success: true, data: manufacturer };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
    return result;
  });
  app.get("/:slug/figures", async (req) => {
    const { slug } = req.params;
    const query = listQuery3.parse(req.query);
    const manufacturer = await app.prisma.manufacturer.findUnique({ where: { slug }, select: { id: true } });
    if (!manufacturer) return { success: true, data: [], meta: { page: 1, perPage: 24, total: 0, totalPages: 0 } };
    const [data, total] = await Promise.all([
      app.prisma.figure.findMany({
        where: { manufacturerId: manufacturer.id, isDeleted: false },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { releaseDate: "desc" },
        include: {
          series: { select: { id: true, slug: true, name: true, nameEn: true } },
          images: { orderBy: { sortOrder: "asc" }, take: 1, select: { id: true, alt: true, size: true, format: true } },
          categories: { include: { category: { select: { slug: true, name: true } } } }
        }
      }),
      app.prisma.figure.count({ where: { manufacturerId: manufacturer.id, isDeleted: false } })
    ]);
    return { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
  });
  app.post("/", async (req, reply) => {
    const data = createManufacturerSchema.parse(req.body);
    const existing = await app.prisma.manufacturer.findUnique({ where: { slug: data.slug } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    const manufacturer = await app.prisma.manufacturer.create({ data });
    await invalidateManufacturerCache(app);
    return reply.status(201).send({ success: true, data: manufacturer });
  });
  app.put("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const data = updateManufacturerSchema.parse(req.body);
    const existing = await app.prisma.manufacturer.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "MANUFACTURER_NOT_FOUND" } });
    if (data.slug && data.slug !== slug) {
      const slugExists = await app.prisma.manufacturer.findUnique({ where: { slug: data.slug } });
      if (slugExists) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    }
    const manufacturer = await app.prisma.manufacturer.update({ where: { slug }, data });
    await invalidateManufacturerCache(app, slug);
    if (data.slug && data.slug !== slug) await invalidateManufacturerCache(app, data.slug);
    return { success: true, data: manufacturer };
  });
  app.delete("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const existing = await app.prisma.manufacturer.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "MANUFACTURER_NOT_FOUND" } });
    const figureCount = await app.prisma.figure.count({ where: { manufacturerId: existing.id } });
    if (figureCount > 0) return reply.status(409).send({ success: false, error: { code: "HAS_FIGURES", message: `Manufacturer has ${figureCount} figures, reassign them first` } });
    await app.prisma.manufacturer.delete({ where: { slug } });
    await invalidateManufacturerCache(app, slug);
    return { success: true, data: { deleted: true } };
  });
}

// src/routes/sculptor.ts
import { z as z7 } from "zod";
var listQuery4 = z7.object({
  page: z7.coerce.number().min(1).default(1),
  perPage: z7.coerce.number().min(1).max(100).default(50)
});
var createSculptorSchema = z7.object({
  slug: z7.string().min(1),
  name: z7.string().min(1),
  nameJp: z7.string().optional(),
  nameEn: z7.string().optional(),
  alias: z7.array(z7.string()).optional(),
  styleTags: z7.array(z7.string()).optional(),
  description: z7.string().optional()
});
var updateSculptorSchema = createSculptorSchema.partial();
async function invalidateSculptorCache(app, slug) {
  if (slug) {
    await app.redis.del(`sculptors:detail:${slug}`);
  }
  await scanKeys(app.redis, "sculptors:list:*");
}
async function sculptorRoutes(app) {
  app.get("/", async (req) => {
    const query = listQuery4.parse(req.query);
    const cacheKey = `sculptors:list:${query.page}:${query.perPage}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const [data, total] = await Promise.all([
      app.prisma.sculptor.findMany({
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { name: "asc" },
        include: { _count: { select: { figures: true } } }
      }),
      app.prisma.sculptor.count()
    ]);
    const result = { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 600);
    return result;
  });
  app.get("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const cacheKey = `sculptors:detail:${slug}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const sculptor = await app.prisma.sculptor.findUnique({
      where: { slug },
      include: { _count: { select: { figures: true } } }
    });
    if (!sculptor) return reply.status(404).send({ success: false, error: { code: "SCULPTOR_NOT_FOUND" } });
    const result = { success: true, data: sculptor };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
    return result;
  });
  app.get("/:slug/figures", async (req) => {
    const { slug } = req.params;
    const query = listQuery4.parse(req.query);
    const sculptor = await app.prisma.sculptor.findUnique({ where: { slug }, select: { id: true } });
    if (!sculptor) return { success: true, data: [], meta: { page: 1, perPage: 24, total: 0, totalPages: 0 } };
    const [data, total] = await Promise.all([
      app.prisma.figure.findMany({
        where: { sculptors: { some: { sculptorId: sculptor.id } }, isDeleted: false },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { releaseDate: "desc" },
        include: {
          manufacturer: { select: { id: true, slug: true, name: true, nameEn: true } },
          series: { select: { id: true, slug: true, name: true, nameEn: true } },
          images: { orderBy: { sortOrder: "asc" }, take: 1, select: { id: true, alt: true, size: true, format: true } },
          categories: { include: { category: { select: { slug: true, name: true } } } }
        }
      }),
      app.prisma.figure.count({ where: { sculptors: { some: { sculptorId: sculptor.id } }, isDeleted: false } })
    ]);
    return { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
  });
  app.post("/", async (req, reply) => {
    const data = createSculptorSchema.parse(req.body);
    const existing = await app.prisma.sculptor.findUnique({ where: { slug: data.slug } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    const sculptor = await app.prisma.sculptor.create({ data });
    await invalidateSculptorCache(app);
    return reply.status(201).send({ success: true, data: sculptor });
  });
  app.put("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const data = updateSculptorSchema.parse(req.body);
    const existing = await app.prisma.sculptor.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "SCULPTOR_NOT_FOUND" } });
    if (data.slug && data.slug !== slug) {
      const slugExists = await app.prisma.sculptor.findUnique({ where: { slug: data.slug } });
      if (slugExists) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    }
    const sculptor = await app.prisma.sculptor.update({ where: { slug }, data });
    await invalidateSculptorCache(app, slug);
    if (data.slug && data.slug !== slug) await invalidateSculptorCache(app, data.slug);
    return { success: true, data: sculptor };
  });
  app.delete("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const existing = await app.prisma.sculptor.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "SCULPTOR_NOT_FOUND" } });
    const figureCount = await app.prisma.figureSculptor.count({ where: { sculptorId: existing.id } });
    if (figureCount > 0) return reply.status(409).send({ success: false, error: { code: "HAS_FIGURES", message: `Sculptor has ${figureCount} figures, reassign them first` } });
    await app.prisma.sculptor.delete({ where: { slug } });
    await invalidateSculptorCache(app, slug);
    return { success: true, data: { deleted: true } };
  });
}

// src/routes/characters.ts
import { z as z8 } from "zod";
var listQuery5 = z8.object({
  page: z8.coerce.number().min(1).default(1),
  perPage: z8.coerce.number().min(1).max(100).default(50),
  lang: z8.string().optional()
});
var createCharacterSchema = z8.object({
  slug: z8.string().min(1),
  name: z8.string().min(1),
  nameJp: z8.string().optional(),
  nameEn: z8.string().optional(),
  seriesId: z8.coerce.bigint().optional(),
  description: z8.string().optional()
});
var updateCharacterSchema = createCharacterSchema.partial();
async function invalidateCharacterCache(app, slug) {
  if (slug) {
    await app.redis.del(`characters:detail:${slug}`);
  }
  await scanKeys(app.redis, "characters:list:*");
}
function publicSlug3(slug) {
  return String(slug || "").replace(/-+$/g, "");
}
function firstText3(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
function publicFigureCard(figure) {
  const localized = Array.isArray(figure.localized) ? figure.localized[0] : null;
  const displayTitle = firstText3(localized?.title, figure.nameEn, figure.name, figure.nameJp, figure.slug) || "";
  const originalTitle = firstText3(figure.nameJp, figure.name, figure.nameEn, displayTitle) || displayTitle;
  const displayDescription = firstText3(localized?.description, figure.description);
  return {
    ...figure,
    slug: publicSlug3(figure.slug),
    displayTitle,
    originalTitle,
    displayDescription
  };
}
async function characterRoutes(app) {
  app.get("/", async (req) => {
    const query = listQuery5.parse(req.query);
    const cacheKey = `characters:list:${query.page}:${query.perPage}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const [data, total] = await Promise.all([
      app.prisma.character.findMany({
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { name: "asc" },
        include: { _count: { select: { figures: true } }, series: { select: { id: true, slug: true, name: true, nameEn: true } } }
      }),
      app.prisma.character.count()
    ]);
    const result = { success: true, data, meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 600);
    return result;
  });
  app.get("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const cacheKey = `characters:detail:${slug}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    const character = await app.prisma.character.findUnique({
      where: { slug },
      include: { _count: { select: { figures: true } }, series: { select: { id: true, slug: true, name: true, nameEn: true } } }
    });
    if (!character) return reply.status(404).send({ success: false, error: { code: "CHARACTER_NOT_FOUND" } });
    const result = { success: true, data: character };
    await app.redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
    return result;
  });
  app.get("/:slug/figures", async (req) => {
    const { slug } = req.params;
    const query = listQuery5.parse(req.query);
    const lang = query.lang || "fr";
    const character = await app.prisma.character.findUnique({ where: { slug }, select: { id: true } });
    if (!character) return { success: true, data: [], meta: { page: 1, perPage: 24, total: 0, totalPages: 0 } };
    const [data, total] = await Promise.all([
      app.prisma.figure.findMany({
        where: { characters: { some: { characterId: character.id } }, isDeleted: false },
        skip: (query.page - 1) * query.perPage,
        take: query.perPage,
        orderBy: { releaseDate: "desc" },
        include: {
          manufacturer: { select: { id: true, slug: true, name: true, nameEn: true } },
          series: { select: { id: true, slug: true, name: true, nameJp: true, nameEn: true } },
          localized: { where: { language: lang }, orderBy: { id: "asc" } },
          images: { orderBy: { sortOrder: "asc" }, take: 1, select: { id: true, alt: true, size: true, format: true } },
          categories: { include: { category: { select: { slug: true, name: true } } } }
        }
      }),
      app.prisma.figure.count({ where: { characters: { some: { characterId: character.id } }, isDeleted: false } })
    ]);
    return { success: true, data: data.map(publicFigureCard), meta: { page: query.page, perPage: query.perPage, total, totalPages: Math.ceil(total / query.perPage) } };
  });
  app.post("/", async (req, reply) => {
    const data = createCharacterSchema.parse(req.body);
    const existing = await app.prisma.character.findUnique({ where: { slug: data.slug } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    const character = await app.prisma.character.create({ data });
    await invalidateCharacterCache(app);
    return reply.status(201).send({ success: true, data: character });
  });
  app.put("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const data = updateCharacterSchema.parse(req.body);
    const existing = await app.prisma.character.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "CHARACTER_NOT_FOUND" } });
    if (data.slug && data.slug !== slug) {
      const slugExists = await app.prisma.character.findUnique({ where: { slug: data.slug } });
      if (slugExists) return reply.status(409).send({ success: false, error: { code: "SLUG_EXISTS" } });
    }
    const character = await app.prisma.character.update({ where: { slug }, data });
    await invalidateCharacterCache(app, slug);
    if (data.slug && data.slug !== slug) await invalidateCharacterCache(app, data.slug);
    return { success: true, data: character };
  });
  app.delete("/:slug", async (req, reply) => {
    const { slug } = req.params;
    const existing = await app.prisma.character.findUnique({ where: { slug } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "CHARACTER_NOT_FOUND" } });
    const figureCount = await app.prisma.figureCharacter.count({ where: { characterId: existing.id } });
    if (figureCount > 0) return reply.status(409).send({ success: false, error: { code: "HAS_FIGURES", message: `Character has ${figureCount} figures, reassign them first` } });
    await app.prisma.character.delete({ where: { slug } });
    await invalidateCharacterCache(app, slug);
    return { success: true, data: { deleted: true } };
  });
}

// src/routes/admin.ts
import { z as z16 } from "zod";

// src/shared/cache/cache-service.ts
var CACHE_ALLOWLIST = [
  "figures:detail:*",
  "figures:list:*",
  "search:*",
  "homepage:*",
  "series:list:*",
  "sculptors:list:*",
  "manufacturers:list:*",
  "characters:list:*",
  "categories:*",
  "legacy:import:result:*"
];
var BLOCKED_NAMESPACE_PREFIXES = ["review:", "crawler:", "session:", "rate-limit:"];
function isAllowedPattern(pattern) {
  if (!pattern || typeof pattern !== "string") return false;
  for (const blocked of BLOCKED_NAMESPACE_PREFIXES) {
    if (pattern.startsWith(blocked) || pattern.includes(blocked)) return false;
  }
  for (const allowed of CACHE_ALLOWLIST) {
    const re = new RegExp("^" + allowed.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    if (re.test(pattern)) return true;
  }
  return false;
}
function validatePatterns(patterns) {
  const invalid = [];
  for (const p of patterns) {
    if (!isAllowedPattern(p)) invalid.push(p);
  }
  return invalid;
}
var CacheService = class {
  constructor(redis) {
    this.redis = redis;
  }
  redis;
  async invalidateByPattern(pattern, options) {
    if (!isAllowedPattern(pattern)) {
      throw Object.assign(new Error(`Pattern not allowed: ${pattern}`), { code: "NAMESPACE_NOT_ALLOWED" });
    }
    const result = await scanKeys(this.redis, pattern, {
      signal: options?.signal,
      count: options?.count
    });
    return {
      matched: result.matched,
      deleted: result.deleted,
      failed: result.failed,
      truncated: result.truncated,
      namespaces: [pattern]
    };
  }
  async invalidateByPatterns(patterns, options) {
    const invalid = validatePatterns(patterns);
    if (invalid.length > 0) {
      throw Object.assign(new Error(`Patterns not allowed: ${invalid.join(", ")}`), {
        code: "NAMESPACE_NOT_ALLOWED",
        patterns: invalid
      });
    }
    let totalMatched = 0;
    let totalDeleted = 0;
    let totalFailed = 0;
    let truncated = false;
    for (const pattern of patterns) {
      if (options?.signal?.aborted) {
        truncated = true;
        break;
      }
      const result = await scanKeys(this.redis, pattern, {
        signal: options?.signal,
        count: options?.count
      });
      totalMatched += result.matched;
      totalDeleted += result.deleted;
      totalFailed += result.failed;
      if (result.truncated) truncated = true;
    }
    return {
      matched: totalMatched,
      deleted: totalDeleted,
      failed: totalFailed,
      truncated,
      namespaces: patterns
    };
  }
  async get(key) {
    const raw = await this.redis.get(key);
    if (raw === null || raw === void 0) return null;
    return JSON.parse(raw);
  }
  async set(key, value, ttlSeconds) {
    const serialized = JSON.stringify(value);
    if (ttlSeconds !== void 0) {
      await this.redis.set(key, serialized, "EX", ttlSeconds);
    } else {
      await this.redis.set(key, serialized);
    }
  }
  async del(key) {
    const result = await this.redis.unlink(key);
    return result > 0;
  }
};

// src/modules/admin-cache/routes.ts
var CACHE_ALLOWLIST2 = [
  "figures:detail:*",
  "figures:list:*",
  "search:*",
  "homepage:*",
  "series:list:*",
  "sculptors:list:*",
  "manufacturers:list:*",
  "characters:list:*",
  "categories:*",
  "legacy:import:result:*"
];
var BLOCKED_NAMESPACES = ["review:", "crawler:", "session:", "rate-limit:"];
function isAllowedPattern2(p) {
  if (!p || typeof p !== "string") return false;
  for (const blocked of BLOCKED_NAMESPACES) {
    if (p.startsWith(blocked) || p.includes(blocked)) return false;
  }
  for (const allowed of CACHE_ALLOWLIST2) {
    const re = new RegExp("^" + allowed.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    if (re.test(p)) return true;
  }
  return false;
}
async function adminCacheRoutes(app) {
  const cacheService = new CacheService(app.redis);
  app.post("/cache/purge", async (req, reply) => {
    const body = req.body || {};
    const pattern = typeof body.pattern === "string" ? body.pattern : void 0;
    const paths = Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === "string" && p.length > 0) : [];
    if (body.purgeAll === true || !pattern && paths.length === 0 || pattern === "*") {
      return reply.status(422).send({ success: false, error: { code: "PURGE_ALL_BLOCKED", message: "Full flush is not allowed. Use specific namespace patterns." } });
    }
    const namespaces = [];
    const keySet = /* @__PURE__ */ new Set();
    if (pattern) {
      if (!isAllowedPattern2(pattern)) {
        return reply.status(422).send({ success: false, error: { code: "NAMESPACE_NOT_ALLOWED", message: `Pattern "${pattern}" is not in the allowed cache namespace list` } });
      }
      namespaces.push(pattern);
      let cursor = "0";
      do {
        const [cursor2, keys2] = await app.redis.scan(cursor, "MATCH", pattern, "COUNT", "100");
        cursor = cursor2;
        for (const k of keys2) keySet.add(k);
      } while (cursor !== "0");
    }
    for (const path5 of paths) {
      const m = path5.match(/^\/figures?\/([^/]+)\/?$/);
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
        const [nextCursor, scanKeys2] = await app.redis.scan(cursor2, "MATCH", "figures:list:*", "COUNT", "100");
        cursor2 = nextCursor;
        for (const k of scanKeys2) keySet.add(k);
      } while (cursor2 !== "0");
    }
    const keys = Array.from(keySet);
    let deleted = 0;
    if (keys.length > 0) {
      deleted = await app.redis.unlink(...keys);
    }
    return { success: true, data: { purged: true, mode: "targeted", matched: keys.length, deleted, namespaces } };
  });
}

// src/modules/admin-users/routes.ts
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";

// src/modules/admin-users/schemas.ts
import { z as z9 } from "zod";
var updateUserSchema = z9.object({
  displayName: z9.string().min(1).optional(),
  role: z9.enum(["admin", "editor", "viewer"]).optional(),
  isActive: z9.boolean().optional()
});
var createUserSchema = z9.object({
  email: z9.string().email(),
  password: z9.string().min(1),
  displayName: z9.string().min(1),
  role: z9.enum(["admin", "editor", "viewer"]).default("viewer")
});
var passwordUpdateSchema = z9.object({ newPassword: z9.string().min(1) });
function safeBigInt2(value) {
  try {
    if (!/^-?\d+$/.test(value)) return null;
    return BigInt(value);
  } catch {
    return null;
  }
}
function isValidPassword(pwd) {
  if (!pwd || typeof pwd !== "string") return false;
  if (pwd.length < 8 || pwd.length > 128) return false;
  if (!/[A-Z]/.test(pwd)) return false;
  if (!/[a-z]/.test(pwd)) return false;
  if (!/[^A-Za-z0-9]/.test(pwd)) return false;
  return true;
}

// src/modules/admin-users/routes.ts
async function adminUserRoutes(app) {
  app.get("/users", async () => {
    const users = await app.prisma.user.findMany({
      select: { id: true, email: true, displayName: true, role: true, isActive: true, emailVerifiedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" }
    });
    return { success: true, data: users };
  });
  app.put("/users/:id", async (req, reply) => {
    const { id } = req.params;
    const userId = safeBigInt2(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });
    const data = updateUserSchema.parse(req.body);
    const currentUser = req.user;
    const TX_OPTS = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 2e3, timeout: 1e4 };
    const result = await app.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id: userId } });
      if (!existing) return { status: 404, error: { code: "USER_NOT_FOUND" } };
      const demotingSelf = currentUser && safeBigInt2(currentUser.id) === userId && data.role && data.role !== "admin" && existing.role === "admin";
      if (demotingSelf) {
        return { status: 400, error: { code: "CANNOT_DEMOTE_SELF", message: "Cannot demote yourself from admin" } };
      }
      const deactivating = data.isActive === false && existing.role === "admin" && existing.isActive === true;
      if (data.role && data.role !== "admin" && existing.role === "admin") {
        const adminCount = await tx.user.count({ where: { role: "admin", isActive: true } });
        if (adminCount <= 1) {
          return { status: 400, error: { code: "LAST_ADMIN", message: "Cannot demote the last active admin" } };
        }
      }
      if (deactivating) {
        const adminCount = await tx.user.count({ where: { role: "admin", isActive: true } });
        if (adminCount <= 1) {
          return { status: 400, error: { code: "LAST_ADMIN", message: "Cannot deactivate the last active admin" } };
        }
      }
      const user = await tx.user.update({
        where: { id: userId },
        data,
        select: { id: true, email: true, displayName: true, role: true, isActive: true, emailVerifiedAt: true, createdAt: true }
      });
      return { status: 200, data: user };
    }, TX_OPTS);
    if (result.error) {
      return reply.status(result.status).send({ success: false, error: result.error });
    }
    return { success: true, data: result.data };
  });
  app.put("/users/:id/password", async (req, reply) => {
    const { id } = req.params;
    const userId = safeBigInt2(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });
    const { newPassword } = passwordUpdateSchema.parse(req.body);
    if (!isValidPassword(newPassword)) {
      return reply.status(422).send({ success: false, error: { code: "WEAK_PASSWORD", message: "\u5BC6\u7801\u9700\u81F3\u5C118\u4F4D\u4E14\u5305\u542B\u5927\u5C0F\u5199\u5B57\u6BCD\u548C\u7279\u6B8A\u5B57\u7B26" } });
    }
    const existing = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "USER_NOT_FOUND" } });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await app.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return { success: true, data: { message: "\u5BC6\u7801\u5DF2\u91CD\u7F6E" } };
  });
  app.post("/users", async (req, reply) => {
    const data = createUserSchema.parse(req.body);
    if (!isValidPassword(data.password)) {
      return reply.status(422).send({ success: false, error: { code: "WEAK_PASSWORD", message: "\u5BC6\u7801\u9700\u81F3\u5C118\u4F4D\u4E14\u5305\u542B\u5927\u5C0F\u5199\u5B57\u6BCD\u548C\u7279\u6B8A\u5B57\u7B26" } });
    }
    const existing = await app.prisma.user.findUnique({ where: { email: data.email } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "EMAIL_EXISTS", message: "\u90AE\u7BB1\u5DF2\u88AB\u4F7F\u7528" } });
    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await app.prisma.user.create({
      data: { email: data.email, passwordHash, displayName: data.displayName, role: data.role, emailVerifiedAt: /* @__PURE__ */ new Date() },
      select: { id: true, email: true, displayName: true, role: true, isActive: true, emailVerifiedAt: true, createdAt: true }
    });
    return reply.status(201).send({ success: true, data: user });
  });
  app.delete("/users/:id", async (req, reply) => {
    const { id } = req.params;
    const userId = safeBigInt2(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });
    const currentUser = req.user;
    const TX_OPTS = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 2e3, timeout: 1e4 };
    const result = await app.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) return { status: 404, error: { code: "USER_NOT_FOUND", message: "\u7528\u6237\u4E0D\u5B58\u5728" } };
      const deletingSelf = currentUser && safeBigInt2(currentUser.id) === userId;
      if (deletingSelf) {
        return { status: 400, error: { code: "CANNOT_DELETE_SELF", message: "Cannot delete your own account" } };
      }
      if (user.role === "admin") {
        const adminCount = await tx.user.count({ where: { role: "admin", isActive: true } });
        if (adminCount <= 1) {
          return { status: 400, error: { code: "LAST_ADMIN", message: "Cannot delete the last active admin" } };
        }
      }
      await tx.favoriteGroup.deleteMany({ where: { userId } });
      await tx.favorite.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
      return { status: 200, data: { message: "\u7528\u6237\u5DF2\u5220\u9664" } };
    }, TX_OPTS);
    if (result.error) {
      return reply.status(result.status).send({ success: false, error: result.error });
    }
    return { success: true, data: result.data };
  });
}

// src/modules/admin-crawler/schemas.ts
import { z as z10 } from "zod";
var crawlerRunnerSchema = z10.enum(["server_safe", "local_browser", "proxy_browser", "manual"]);
var crawlerJobStatusSchema = z10.enum(["queued", "claimed", "running", "succeeded", "failed", "deferred", "cancelled"]);
var crawlerJobSchema = z10.object({
  source: z10.string().min(1),
  task: z10.string().min(1),
  runner: crawlerRunnerSchema.default("server_safe"),
  status: crawlerJobStatusSchema.default("queued"),
  priority: z10.coerce.number().int().min(0).max(3).default(1),
  payload: z10.any().optional(),
  notBefore: z10.string().datetime().optional(),
  maxAttempts: z10.coerce.number().int().min(1).max(10).default(3),
  notes: z10.string().optional(),
  automation: z10.object({
    provider: z10.enum(["n8n", "hermes", "manual", "other"]).default("manual"),
    workflow: z10.string().optional(),
    runId: z10.string().optional()
  }).optional()
});
var crawlerJobUpdateSchema = z10.object({
  status: crawlerJobStatusSchema.optional(),
  runner: crawlerRunnerSchema.optional(),
  priority: z10.coerce.number().int().min(0).max(3).optional(),
  payload: z10.any().optional(),
  result: z10.any().optional(),
  resultSummary: z10.any().optional(),
  error: z10.string().optional(),
  notes: z10.string().optional(),
  notBefore: z10.string().datetime().nullable().optional()
});
var crawlerJobQuerySchema = z10.object({
  status: crawlerJobStatusSchema.optional(),
  runner: crawlerRunnerSchema.optional(),
  source: z10.string().optional(),
  limit: z10.coerce.number().int().min(1).max(200).default(50)
});
var crawlerClaimSchema = z10.object({
  runner: crawlerRunnerSchema,
  workerId: z10.string().min(1),
  limit: z10.coerce.number().int().min(1).max(10).default(1)
});

// src/modules/admin-crawler/lua-scripts.ts
var CREATE_JOB_LUA = `
  local job_key = KEYS[1]
  local index_key = KEYS[2]
  local job_json = ARGV[1]
  local score = tonumber(ARGV[2])
  local job_id = ARGV[3]

  redis.call("SET", job_key, job_json)
  redis.call("ZADD", index_key, score, job_id)

  return 1
`;
var CLAIM_JOB_LUA = `
  local index_key = KEYS[1]
  local max_count = tonumber(ARGV[1])
  local runner = ARGV[2]
  local worker_id = ARGV[3]
  local now_ms = tonumber(ARGV[4])
  local iso_now = ARGV[5]

  local ids = redis.call("ZREVRANGE", index_key, 0, 500)
  local claimed = {}
  local claimed_count = 0

  for i, id in ipairs(ids) do
    if claimed_count >= max_count then break end

    local job_key = "crawler:job:" .. id
    local raw = redis.call("GET", job_key)
    if not raw then
    else
      local ok, job = pcall(cjson.decode, raw)
      if ok then
        local can_claim = false

        if (job["status"] == "queued" or job["status"] == "deferred") and job["runner"] == runner then
          can_claim = true
          local nb = job["notBeforeMs"]
          if nb and tonumber(nb) and tonumber(nb) > now_ms then
            can_claim = false
          end
        end

        local attempts = job["attempts"] or 0
        local maxAttempts = job["maxAttempts"] or 3
        if can_claim and attempts >= maxAttempts then
          can_claim = false
        end

        if can_claim then
          job["status"] = "claimed"
          job["workerId"] = worker_id
          job["attempts"] = attempts + 1
          job["claimedAt"] = iso_now
          job["updatedAt"] = iso_now

          redis.call("SET", job_key, cjson.encode(job))
          table.insert(claimed, cjson.encode(job))
          claimed_count = claimed_count + 1
        end
      end
    end
  end

  return claimed
`;

// src/modules/admin-crawler/routes.ts
async function adminCrawlerRoutes(app) {
  app.get("/crawler/jobs", async (req) => {
    const query = crawlerJobQuerySchema.parse(req.query || {});
    const ids = await app.redis.zrevrange("crawler:jobs", 0, Math.max(query.limit * 5, query.limit) - 1);
    const jobs = [];
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
      } catch {
      }
    }
    return { success: true, data: jobs, meta: { count: jobs.length, limit: query.limit } };
  });
  app.post("/crawler/jobs", async (req, reply) => {
    const data = crawlerJobSchema.parse(req.body);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const notBeforeMs = data.notBefore ? Date.parse(data.notBefore) : null;
    const job = { id, attempts: 0, ...data, notBeforeMs, createdAt: now, updatedAt: now };
    const score = Date.now() + data.priority * 1e9;
    const jobKey = `crawler:job:${id}`;
    const indexKey = "crawler:jobs";
    try {
      await app.redis.eval(CREATE_JOB_LUA, 2, jobKey, indexKey, JSON.stringify(job), String(score), id);
    } catch {
      const multi = app.redis.multi();
      multi.set(jobKey, JSON.stringify(job));
      multi.zadd(indexKey, score, id);
      await multi.exec();
    }
    return reply.status(201).send({ success: true, data: job });
  });
  app.post("/crawler/jobs/claim", async (req, reply) => {
    const data = crawlerClaimSchema.parse(req.body);
    const nowMs = Date.now();
    const isoNow = (/* @__PURE__ */ new Date()).toISOString();
    try {
      const rawResults = await app.redis.eval(
        CLAIM_JOB_LUA,
        1,
        "crawler:jobs",
        String(data.limit),
        data.runner,
        data.workerId,
        String(nowMs),
        isoNow
      );
      const claimedJobs = Array.isArray(rawResults) ? rawResults.map((r) => JSON.parse(r)) : [];
      return { success: true, data: claimedJobs, meta: { count: claimedJobs.length } };
    } catch (err) {
      return reply.status(503).send({
        success: false,
        error: { code: "CLAIM_ATOMIC_FAILED", message: "Redis atomic claim failed: " + (err?.message || "unknown") }
      });
    }
  });
  app.get("/crawler/jobs/:id", async (req, reply) => {
    const { id } = req.params;
    const raw = await app.redis.get(`crawler:job:${id}`);
    if (!raw) return reply.status(404).send({ success: false, error: { code: "CRAWLER_JOB_NOT_FOUND", message: "Crawler job not found" } });
    try {
      return { success: true, data: JSON.parse(raw) };
    } catch {
      return reply.status(500).send({ success: false, error: { code: "CRAWLER_JOB_PARSE_ERROR", message: "Failed to parse job JSON" } });
    }
  });
  app.put("/crawler/jobs/:id", async (req, reply) => {
    const { id } = req.params;
    const existingRaw = await app.redis.get(`crawler:job:${id}`);
    if (!existingRaw) return reply.status(404).send({ success: false, error: { code: "CRAWLER_JOB_NOT_FOUND" } });
    const update = crawlerJobUpdateSchema.parse(req.body);
    const existing = JSON.parse(existingRaw);
    const job = { ...existing, ...update, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    await app.redis.set(`crawler:job:${id}`, JSON.stringify(job));
    return { success: true, data: job };
  });
}

// src/modules/admin-import/routes.ts
import { z as z11 } from "zod";

// src/modules/images/image-service.ts
import https2 from "https";
import http2 from "http";
import fs3 from "fs";

// src/modules/images/image-security.ts
import dns2 from "dns";
var BLOCKED_HOSTS2 = /* @__PURE__ */ new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
  "metadata.google.internal",
  "169.254.169.254",
  "100.100.100.200",
  "metadata.internal"
]);
function isPrivateIP(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 0) return true;
  return false;
}
function isPrivateIPv6(ip) {
  if (ip === "::1" || ip === "[::1]") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return true;
  if (ip.startsWith("::ffff:")) {
    const mapped4 = ip.replace(/^::ffff:/, "");
    return isPrivateIP(mapped4);
  }
  if (ip.startsWith("::ffff:0:")) {
    const mapped4 = ip.replace(/^::ffff:0:/, "");
    return isPrivateIP(mapped4);
  }
  return false;
}
async function resolveAndValidateHost2(host) {
  try {
    const addresses = await dns2.promises.resolve4(host);
    for (const addr of addresses) {
      if (BLOCKED_HOSTS2.has(addr)) return { ok: false, reason: `Blocked IP: ${addr}` };
      if (isPrivateIP(addr)) return { ok: false, reason: `Private IP not allowed: ${addr}` };
    }
    return { ok: true, address: addresses[0] };
  } catch {
    try {
      const addrs = await dns2.promises.resolve6(host);
      for (const addr of addrs) {
        if (BLOCKED_HOSTS2.has(addr)) return { ok: false, reason: `Blocked IPv6: ${addr}` };
        if (isPrivateIPv6(addr)) return { ok: false, reason: `Private IPv6 not allowed: ${addr}` };
      }
      return { ok: true, address: addrs[0] };
    } catch {
      return { ok: false, reason: "DNS resolution failed" };
    }
  }
}
async function validateImageUrl2(imageUrl) {
  try {
    const u = new URL(imageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "Only http(s) URLs are allowed" };
    const host = u.hostname.toLowerCase();
    if (BLOCKED_HOSTS2.has(host)) return { ok: false, reason: "Blocked host" };
    if (host === "::1" || host === "[::1]") return { ok: false, reason: "Blocked IPv6 loopback" };
    const resolved = await resolveAndValidateHost2(host);
    if (!resolved.ok) return { ok: false, reason: resolved.reason || "Host validation failed" };
    if (resolved.address) {
      const ipv6 = resolved.address.includes(":");
      if (ipv6 && isPrivateIPv6(resolved.address)) return { ok: false, reason: `Private IPv6 not allowed: ${resolved.address}` };
    }
    return { ok: true, resolvedAddress: resolved.address };
  } catch (e) {
    return { ok: false, reason: "Invalid URL: " + (e?.message || "") };
  }
}

// src/modules/images/image-storage.ts
import crypto2 from "crypto";
import fs2 from "fs";
import path2 from "path";
import sharp2 from "sharp";
var ASSETS_PATH2 = process.env.ASSETS_PATH || "/app/assets";
var IMAGE_SIZES2 = {
  raw: { width: 0, quality: 90 },
  detail: { width: 800, quality: 85 },
  thumb: { width: 300, quality: 75 }
};
var MAX_IMAGE_SIZE2 = 10 * 1024 * 1024;
var MAX_RESPONSE_SIZE = 15 * 1024 * 1024;
var DOWNLOAD_TIMEOUT2 = 15e3;
var MAX_REDIRECTS2 = 5;
function getImageDir2(janCode) {
  if (!validateJanCode2(janCode)) {
    throw new Error(`Invalid janCode: ${janCode}`);
  }
  return path2.join(ASSETS_PATH2, "figures", janCode);
}
function getImageFilePath2(janCode, sha256, size) {
  if (!validateJanCode2(janCode)) {
    throw new Error(`Invalid janCode: ${janCode}`);
  }
  if (!validateSha2562(sha256)) {
    throw new Error(`Invalid sha256: ${sha256}`);
  }
  const resolvedPath = path2.resolve(path2.join(getImageDir2(janCode), `${sha256}_${size}.webp`));
  const allowedPrefix = path2.resolve(path2.join(ASSETS_PATH2, "figures"));
  if (!resolvedPath.startsWith(allowedPrefix)) {
    throw new Error("Path traversal detected: resolved path outside figures directory");
  }
  return resolvedPath;
}
function validateJanCode2(janCode) {
  if (!janCode || typeof janCode !== "string") return false;
  if (/[\\/]/.test(janCode)) return false;
  if (janCode.includes("..")) return false;
  if (janCode.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(janCode) || janCode === "no-jancode";
}
function validateSha2562(sha256) {
  if (!sha256 || typeof sha256 !== "string") return false;
  return /^[a-f0-9]{64}$/i.test(sha256);
}
function computeSha2562(buffer) {
  return crypto2.createHash("sha256").update(buffer).digest("hex");
}
async function processAndStoreImageFiles(buffer, janCode, source, options) {
  const { alt, sortOrder = 0, isNsfw = false } = options || {};
  const sha256 = computeSha2562(buffer);
  const dir = getImageDir2(janCode);
  fs2.mkdirSync(dir, { recursive: true });
  const metadata = await sharp2(buffer).metadata();
  const originalWidth = metadata.width || 0;
  const results = [];
  const writtenTmpPaths = [];
  try {
    for (const [sizeName, config] of Object.entries(IMAGE_SIZES2)) {
      const filePath = getImageFilePath2(janCode, sha256, sizeName);
      if (fs2.existsSync(filePath)) {
        const stat = fs2.statSync(filePath);
        results.push({
          janCode,
          sha256,
          size: sizeName,
          format: "webp",
          width: config.width || originalWidth,
          height: metadata.height || 0,
          fileSize: stat.size,
          alt,
          sortOrder,
          source,
          isNsfw
        });
        continue;
      }
      let processed = buffer;
      if (config.width > 0) {
        processed = await sharp2(buffer).resize({ width: config.width, withoutEnlargement: true }).webp({ quality: config.quality }).toBuffer();
      } else {
        processed = await sharp2(buffer).webp({ quality: config.quality }).toBuffer();
      }
      const tmpPath = filePath + ".tmp." + crypto2.randomBytes(8).toString("hex");
      fs2.writeFileSync(tmpPath, processed);
      writtenTmpPaths.push(tmpPath);
      fs2.renameSync(tmpPath, filePath);
      results.push({
        janCode,
        sha256,
        size: sizeName,
        format: "webp",
        width: config.width || originalWidth,
        height: metadata.height ? Math.round(metadata.height * (config.width ? config.width / originalWidth : 1)) : 0,
        fileSize: processed.length,
        alt,
        sortOrder,
        source,
        isNsfw
      });
    }
  } finally {
    for (const tmp of writtenTmpPaths) {
      try {
        if (fs2.existsSync(tmp)) fs2.unlinkSync(tmp);
      } catch {
      }
    }
  }
  return results;
}

// src/modules/images/image-repository.ts
async function upsertFigureImageRecord2(prisma, input) {
  const source = input.source ? String(input.source) : null;
  const sha256 = input.sha256 ? String(input.sha256) : null;
  const size = String(input.size || "raw");
  const whereBase = { figureId: input.figureId, size };
  let existing = source ? await prisma.figureImage.findFirst({ where: { ...whereBase, source }, orderBy: { id: "asc" } }) : null;
  if (!existing && sha256) {
    existing = await prisma.figureImage.findFirst({ where: { ...whereBase, sha256 }, orderBy: { id: "asc" } });
  }
  const payload = {
    figureId: input.figureId,
    janCode: input.janCode ?? null,
    sha256,
    size,
    format: input.format || "webp",
    width: input.width ?? null,
    height: input.height ?? null,
    fileSize: input.fileSize ?? null,
    alt: input.alt || null,
    sortOrder: input.sortOrder ?? 0,
    source,
    isNsfw: input.isNsfw || false,
    data: input.data ?? null
  };
  const image = existing ? await prisma.figureImage.update({ where: { id: existing.id }, data: payload }) : await prisma.figureImage.create({ data: payload });
  return { image, created: !existing };
}

// src/modules/images/image-service.ts
async function downloadImage2(imageUrl, redirectDepth = 0) {
  if (redirectDepth > MAX_REDIRECTS2) return Promise.reject(new Error("Too many redirects"));
  const { ok, resolvedAddress } = await validateImageUrl2(imageUrl);
  if (!ok) return Promise.reject(new Error("URL validation failed"));
  return new Promise((resolve, reject) => {
    const u = new URL(imageUrl);
    const isHttps = u.protocol === "https:";
    const port = parseInt(u.port) || (isHttps ? 443 : 80);
    const path5 = u.pathname + u.search;
    const hostname = u.hostname;
    const opts = {
      host: resolvedAddress,
      port,
      path: path5,
      method: "GET",
      timeout: DOWNLOAD_TIMEOUT2,
      headers: {
        "User-Agent": "ModelWiki/1.0",
        "Host": hostname
      }
    };
    const client = isHttps ? https2 : http2;
    if (isHttps) {
      opts.servername = hostname;
    }
    const req = client.request(opts, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        const nextUrl = new URL(res.headers.location, imageUrl).href;
        validateImageUrl2(nextUrl).then((nextCheck) => {
          if (!nextCheck.ok) return reject(new Error("Redirect target blocked"));
          return downloadImage2(nextUrl, redirectDepth + 1).then(resolve).catch(reject);
        }).catch(reject);
        return;
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const ct = res.headers["content-type"] || "";
      if (ct && !ct.startsWith("image/")) return reject(new Error("Not an image"));
      const chunks = [];
      let totalSize = 0;
      res.on("data", (chunk) => {
        totalSize += chunk.length;
        if (totalSize > MAX_RESPONSE_SIZE) {
          req.destroy();
          reject(new Error("Response too large"));
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: ct }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Download timeout"));
    });
  });
}
function rollbackStoredFiles(janCode, records) {
  const sizes = ["raw", "detail", "thumb"];
  for (const rec of records) {
    for (const size of sizes) {
      try {
        const fp3 = getImageFilePath2(janCode, rec.sha256, size);
        if (fs3.existsSync(fp3)) fs3.unlinkSync(fp3);
      } catch {
      }
    }
  }
}
async function processAndStoreImage2(imageUrl, janCode, prisma, options) {
  const { alt, sortOrder = 0, isNsfw = false, figureId } = options || {};
  const { buffer } = await downloadImage2(imageUrl);
  const sha256 = computeSha2562(buffer);
  const records = await processAndStoreImageFiles(buffer, janCode, imageUrl, { alt, sortOrder, isNsfw });
  if (figureId) {
    try {
      for (const rec of records) {
        await upsertFigureImageRecord2(prisma, {
          figureId,
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
          isNsfw: rec.isNsfw
        });
      }
    } catch (dbErr) {
      rollbackStoredFiles(janCode, records);
      throw dbErr;
    }
  }
  return records;
}

// src/modules/admin-import/routes.ts
function isEnabled() {
  return process.env.ENABLE_LEGACY_ADMIN_IMPORTS === "true";
}
function disabled(reply) {
  return reply.status(410).send({
    success: false,
    error: { code: "LEGACY_IMPORT_DISABLED", message: "Legacy admin import endpoints are disabled" }
  });
}
var importRequestSchema = z11.object({
  idempotencyKey: z11.string().min(1).max(128).optional(),
  figures: z11.array(z11.object({
    slug: z11.string().min(1),
    name: z11.string().min(1),
    nameJp: z11.string().optional(),
    nameEn: z11.string().optional(),
    scale: z11.string().optional(),
    material: z11.string().optional(),
    priceJpy: z11.number().int().optional(),
    releaseDate: z11.string().optional(),
    heightMm: z11.number().int().optional(),
    seriesSlug: z11.string().optional(),
    manufacturerSlug: z11.string().optional(),
    mfcId: z11.string().optional(),
    images: z11.array(z11.object({ url: z11.string().url(), alt: z11.string().optional(), source: z11.string().optional() })).optional()
  })).min(1).max(100)
});
async function processFigureImages(prisma, log, figure, images, janCode, figName) {
  if (images.length === 0) return { created: 0, errors: [] };
  if (!janCode) return { created: 0, errors: images.map((i) => ({ url: i.url, error: "No janCode" })) };
  let created = 0;
  const errors = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    try {
      await processAndStoreImage2(img.url, janCode, prisma, {
        alt: img.alt || figName,
        sortOrder: i,
        figureId: figure.id
      });
      created++;
    } catch (err) {
      errors.push({ url: img.url, error: err?.message || "Image processing failed" });
      log.error({ err, url: img.url, figureId: String(figure.id) }, "Image processing failed during legacy import");
    }
  }
  return { created, errors };
}
var IDEMP_TTL_MS = 36e5;
async function adminImportRoutes(app) {
  app.get("/import/status", async (_req, reply) => {
    if (!isEnabled()) return disabled(reply);
    const queueLen = await app.redis.llen("legacy:import:queue");
    const processing = await app.redis.get("legacy:import:processing");
    const recentImports = [];
    const recentKeys = [];
    let cursor = "0";
    do {
      const [nc, ks] = await app.redis.scan(cursor, "MATCH", "legacy:import:result:*", "COUNT", "100");
      cursor = nc;
      for (const k of ks) recentKeys.push(k);
    } while (cursor !== "0");
    for (const key of recentKeys.slice(-10)) {
      const val = await app.redis.get(key);
      if (val) {
        try {
          recentImports.push(JSON.parse(val));
        } catch {
        }
      }
    }
    return {
      success: true,
      data: { queueLength: queueLen, isProcessing: !!processing, currentJob: processing ? JSON.parse(processing) : null, recentImports }
    };
  });
  app.post("/figures/batch", async (req, reply) => {
    if (!isEnabled()) return disabled(reply);
    const data = importRequestSchema.parse(req.body);
    const idempotencyKey = data.idempotencyKey || req.headers["idempotency-key"];
    if (idempotencyKey) {
      const cached = await app.redis.get(`legacy:import:idempot:${idempotencyKey}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        return reply.status(200).send({ success: true, data: { ...parsed, idempotent: true } });
      }
    }
    const results = [];
    let totalFailed = 0;
    let totalPartial = 0;
    let totalCreated = 0;
    for (const fig of data.figures) {
      try {
        const existing = await app.prisma.figure.findFirst({ where: { slug: fig.slug } });
        const images = (fig.images || []).filter((i) => i.url);
        if (existing) {
          const janCode2 = existing.janCode || "";
          if (images.length > 0) {
            const existingImages = await app.prisma.figureImage.findMany({
              where: { figureId: existing.id },
              select: { source: true }
            });
            const existingSources = new Set(existingImages.map((im) => im.source).filter(Boolean));
            const newImages = images.filter((i) => !i.source || !existingSources.has(i.source));
            if (newImages.length > 0) {
              const imgResult2 = await processFigureImages(app.prisma, app.log, existing, newImages, janCode2, fig.name);
              if (imgResult2.errors.length > 0 && imgResult2.created === 0) {
                results.push({ slug: fig.slug, status: "failed", id: String(existing.id), stage: "image", error: `All ${newImages.length} new images failed` });
                totalFailed++;
                continue;
              }
              if (imgResult2.errors.length > 0) {
                results.push({ slug: fig.slug, status: "partial_failed", id: String(existing.id), stage: "image", error: `${imgResult2.errors.length}/${newImages.length} new images failed` });
                totalPartial++;
                continue;
              }
            }
          }
          results.push({ slug: fig.slug, status: "skipped_exists", id: String(existing.id) });
          continue;
        }
        let seriesId;
        if (fig.seriesSlug) {
          const s = await app.prisma.series.findUnique({ where: { slug: fig.seriesSlug } });
          seriesId = s?.id;
        }
        let manufacturerId;
        if (fig.manufacturerSlug) {
          const m = await app.prisma.manufacturer.findUnique({ where: { slug: fig.manufacturerSlug } });
          manufacturerId = m?.id;
        }
        const { images: _skippedImages, seriesSlug, manufacturerSlug, ...figureData } = fig;
        const figure = await app.prisma.figure.create({
          data: { ...figureData, seriesId, manufacturerId, releaseDate: fig.releaseDate ? new Date(fig.releaseDate) : void 0 }
        });
        if (images.length === 0) {
          results.push({ slug: fig.slug, status: "created", id: String(figure.id) });
          totalCreated++;
          continue;
        }
        const janCode = figure.janCode || "";
        const imgResult = await processFigureImages(app.prisma, app.log, figure, images, janCode, fig.name);
        if (imgResult.errors.length === images.length) {
          results.push({ slug: fig.slug, status: "failed", id: String(figure.id), stage: "image", error: "All images failed" });
          totalFailed++;
        } else if (imgResult.errors.length > 0) {
          results.push({ slug: fig.slug, status: "partial_failed", id: String(figure.id), stage: "image", error: `${imgResult.errors.length}/${images.length} images failed` });
          totalPartial++;
        } else {
          results.push({ slug: fig.slug, status: "created", id: String(figure.id) });
          totalCreated++;
        }
      } catch (err) {
        results.push({ slug: fig.slug, status: "failed", error: err.message, stage: "figure" });
        totalFailed++;
      }
    }
    await scanKeys(app.redis, "figures:*");
    const response = {
      total: data.figures.length,
      created: totalCreated,
      failed: totalFailed,
      partial_failed: totalPartial,
      results,
      stage: totalFailed === data.figures.length ? "failed" : totalPartial > 0 ? "partial_failed" : "created"
    };
    if (idempotencyKey) {
      await app.redis.set(`legacy:import:idempot:${idempotencyKey}`, JSON.stringify(response), "PX", IDEMP_TTL_MS);
    }
    return { success: true, data: response };
  });
}

// src/modules/reviews/service.ts
import crypto3 from "crypto";

// src/modules/reviews/types.ts
var REVIEW_STATUSES = ["pending", "approved", "rejected", "needs_changes", "resolved", "stale"];
var REVIEW_TYPES = ["jan_match", "figure_import", "rewrite", "image", "general", "image_review", "detail_review"];
var REVIEW_RISK_TYPES = [
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
  "general_risk"
];
var REVIEW_ACTIONS = [
  "approve_image",
  "reject_image",
  "keep_placeholder",
  "mark_detail_ok",
  "request_refetch",
  "dismiss_stale",
  "keep_pending"
];
var SUPPRESSING_ACTIONS = [
  "approve_image",
  "reject_image",
  "keep_placeholder",
  "mark_detail_ok",
  "dismiss_stale"
];
var ACTION_STATUS_MAP = {
  approve_image: "approved",
  reject_image: "rejected",
  keep_placeholder: "resolved",
  mark_detail_ok: "resolved",
  request_refetch: "needs_changes",
  dismiss_stale: "resolved",
  keep_pending: "pending"
};
function isSuppressingAction(action) {
  return SUPPRESSING_ACTIONS.includes(action);
}

// src/modules/reviews/service.ts
function stableJsonValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    const source = value;
    const out = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v !== void 0) out[key] = stableJsonValue(v);
    }
    return out;
  }
  return value;
}
function stableJson(value) {
  return JSON.stringify(stableJsonValue(value));
}
function redisKeyPart(value) {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}
function reviewFigureKey(item) {
  const figureId = item.figureId ?? item.payload?.figureId ?? item.payload?.figure?.id;
  const figureSlug = item.figureSlug ?? item.payload?.figureSlug ?? item.payload?.slug ?? item.payload?.figure?.slug;
  if (figureId !== void 0 && figureId !== null && String(figureId) !== "") return `id:${String(figureId)}`;
  if (figureSlug) return `slug:${String(figureSlug)}`;
  return `source:${String(item.source || "unknown")}:${String(item.sourceId || "unknown")}`;
}
function reviewRiskKey(item) {
  return String(item.riskType || item.payload?.riskType || item.type || "general_risk");
}
function usesImageEvidence(item) {
  const riskType = reviewRiskKey(item);
  return ["image", "image_review"].includes(String(item.type || "")) || riskType.startsWith("image_");
}
function usesDetailEvidence(item) {
  const riskType = reviewRiskKey(item);
  return item.type === "detail_review" || riskType.startsWith("detail_") || ["category_uncertain", "general_risk"].includes(riskType);
}
function computeReviewEvidenceFingerprint(item) {
  const payload = item.payload || {};
  const includeImageEvidence = usesImageEvidence(item);
  const includeDetailEvidence = usesDetailEvidence(item);
  const currentEvidence = item.currentStateEvidence || payload.currentStateEvidence || {};
  const currentImages = currentEvidence.images || {};
  const currentDetail = currentEvidence.detail || {};
  const currentImageIds = !includeImageEvidence ? [] : Array.isArray(currentImages.imageIds) ? currentImages.imageIds.map(String).sort() : Array.isArray(payload.currentImageIds) ? payload.currentImageIds.map(String).sort() : Array.isArray(payload.imageIds) ? payload.imageIds.map(String).sort() : [];
  const currentImageRows = includeImageEvidence && Array.isArray(currentImages.rows) ? currentImages.rows.map((row) => ({
    id: row.id == null ? null : String(row.id),
    source: row.source || null,
    sha256: row.sha256 || null,
    width: row.width ?? null,
    height: row.height ?? null,
    size: row.size || null,
    sortOrder: row.sortOrder ?? null,
    sourceKind: row.sourceKind || null,
    safeDisplay: row.safeDisplay === true,
    imageLowQuality: row.imageLowQuality === true
  })) : [];
  const candidate = item.candidateImage || payload.candidateImage || {};
  const detail = item.detailSnapshot || payload.detailSnapshot || {};
  const relevantDetailFields = {
    description: currentDetail.description ?? detail.description ?? payload.description ?? null,
    scale: currentDetail.scale ?? detail.scale ?? payload.scale ?? null,
    material: currentDetail.material ?? detail.material ?? payload.material ?? null,
    priceJpy: currentDetail.priceJpy ?? detail.priceJpy ?? payload.priceJpy ?? null,
    heightMm: currentDetail.heightMm ?? detail.heightMm ?? payload.heightMm ?? null,
    weightG: currentDetail.weightG ?? detail.weightG ?? payload.weightG ?? null,
    productLine: currentDetail.productLine ?? detail.productLine ?? payload.productLine ?? null,
    ageRating: currentDetail.ageRating ?? detail.ageRating ?? payload.ageRating ?? null,
    specCount: currentDetail.specCount ?? detail.specCount ?? null,
    specs: detail.specs || null,
    categories: currentDetail.categories || detail.categories || null,
    manufacturer: currentDetail.manufacturer || detail.manufacturer || detail.manufacturerName || payload.manufacturer || null,
    series: currentDetail.series || detail.series || detail.seriesName || payload.series || null,
    releaseDate: currentDetail.releaseDate || detail.releaseDate || detail.release_date || payload.releaseDate || null
  };
  const evidence = {
    figure: reviewFigureKey(item),
    type: item.type || "general",
    riskType: reviewRiskKey(item),
    source: item.source || null,
    sourceId: item.sourceId || null,
    primaryImageId: includeImageEvidence ? currentImages.primaryImageId || item.currentPublicImage?.imageId || payload.primaryImageId || null : null,
    currentImageIds,
    currentImageRows,
    candidate: {
      imageId: candidate.imageId || null,
      source: candidate.source || null,
      hash: candidate.hash || candidate.sha256 || payload.candidateAssetHash || null,
      width: candidate.width || null,
      height: candidate.height || null
    },
    detail: includeDetailEvidence ? relevantDetailFields : null
  };
  return crypto3.createHash("sha256").update(stableJson(evidence)).digest("hex");
}
function reviewDecisionKey(item) {
  const fingerprint = item.evidenceFingerprint || computeReviewEvidenceFingerprint(item);
  const riskType = reviewRiskKey(item);
  const figureKey = reviewFigureKey(item);
  if (!fingerprint || !riskType || !figureKey) return null;
  return `review:decision:${redisKeyPart(figureKey)}:${redisKeyPart(String(riskType))}:${fingerprint}`;
}
function projectReviewDecision(raw) {
  return {
    reviewItemId: raw?.reviewItemId ?? null,
    figure: raw?.figure ?? null,
    type: raw?.type ?? null,
    riskType: raw?.riskType ?? null,
    evidenceFingerprint: raw?.evidenceFingerprint ?? null,
    action: raw?.action ?? null,
    status: raw?.status ?? null,
    reviewer: raw?.reviewer ?? null,
    decisionReason: raw?.decisionReason ?? null,
    decisionAt: raw?.decisionAt ?? null
  };
}
function reviewDecisionFigureMatches(decision, figureId, figureSlug, mappedFigureId) {
  if (!figureId && !figureSlug && !mappedFigureId) return true;
  const figure = decision?.figure;
  const figureIds = [figureId, mappedFigureId].filter((id) => !!id);
  for (const id of figureIds) {
    const expected = `id:${id}`;
    if (String(figure) === expected) return true;
    if (figure && typeof figure === "object") {
      const objectId = figure.id ?? figure.figureId;
      if (objectId !== void 0 && objectId !== null && String(objectId) === id) return true;
    }
  }
  if (figureSlug) {
    const expected = `slug:${figureSlug}`;
    if (String(figure) === expected) return true;
    if (figure && typeof figure === "object") {
      const objectSlug = figure.slug ?? figure.figureSlug;
      if (objectSlug !== void 0 && objectSlug !== null && String(objectSlug) === figureSlug) return true;
    }
  }
  return false;
}
function reviewDecisionMatchesQuery(decision, query, figureId, figureSlug, mappedFigureId) {
  if (query.riskType && decision?.riskType !== query.riskType) return false;
  if (query.action && decision?.action !== query.action) return false;
  return reviewDecisionFigureMatches(decision, figureId, figureSlug, mappedFigureId);
}

// src/modules/reviews/schemas.ts
import { z as z12 } from "zod";
var reviewStatusSchema = z12.enum(REVIEW_STATUSES);
var queryReviewStatusSchema = z12.union([reviewStatusSchema, z12.literal("all")]);
var reviewTypeSchema = z12.enum(REVIEW_TYPES);
var reviewRiskTypeSchema = z12.enum(REVIEW_RISK_TYPES);
var reviewActionSchema = z12.enum(REVIEW_ACTIONS);
var automationSchema = z12.object({
  provider: z12.enum(["n8n", "hermes", "manual", "other"]).default("manual"),
  workflow: z12.string().optional(),
  runId: z12.string().optional()
}).optional();
var candidateImageSchema = z12.object({
  source: z12.string(),
  imageId: z12.union([z12.number(), z12.string()]).optional(),
  width: z12.number().int().optional(),
  height: z12.number().int().optional(),
  fileSize: z12.number().int().optional(),
  aspectRatio: z12.number().optional(),
  url: z12.string().optional(),
  cachedUrl: z12.string().optional()
}).passthrough().optional();
var currentPublicImageSchema = z12.object({
  imageId: z12.union([z12.number(), z12.string()]).optional(),
  source: z12.string().optional(),
  width: z12.number().int().optional(),
  height: z12.number().int().optional()
}).optional();
var detailSnapshotSchema = z12.object({
  description: z12.string().optional(),
  specCount: z12.number().int().optional(),
  specs: z12.any().optional(),
  categories: z12.array(z12.any()).optional()
}).optional();
var reviewItemSchema = z12.object({
  type: reviewTypeSchema.default("general"),
  title: z12.string().min(1),
  source: z12.string().optional(),
  sourceId: z12.string().optional(),
  status: reviewStatusSchema.default("pending"),
  priority: z12.coerce.number().int().min(0).max(3).default(1),
  confidence: z12.coerce.number().min(0).max(1).optional(),
  figureId: z12.union([z12.number().int(), z12.string()]).optional(),
  figureSlug: z12.string().optional(),
  riskType: reviewRiskTypeSchema.optional(),
  riskReason: z12.string().max(1e3).optional(),
  candidateImage: candidateImageSchema,
  currentPublicImage: currentPublicImageSchema,
  detailSnapshot: detailSnapshotSchema,
  suggestedAction: reviewActionSchema.optional(),
  payload: z12.any().optional(),
  notes: z12.string().optional(),
  automation: automationSchema,
  evidenceFingerprint: z12.string().min(16).max(128).optional(),
  decisionReason: z12.string().max(1e3).nullable().optional(),
  reviewer: z12.string().max(200).nullable().optional(),
  decisionAt: z12.string().datetime().nullable().optional()
});
var candidateImageUpdateSchema = z12.object({
  source: z12.string(),
  imageId: z12.union([z12.number(), z12.string()]).optional(),
  width: z12.number().int().optional(),
  height: z12.number().int().optional(),
  fileSize: z12.number().int().optional(),
  aspectRatio: z12.number().optional(),
  url: z12.string().optional(),
  cachedUrl: z12.string().optional()
}).passthrough().optional();
var reviewUpdateSchema = z12.object({
  status: reviewStatusSchema.optional(),
  priority: z12.coerce.number().int().min(0).max(3).optional(),
  confidence: z12.coerce.number().min(0).max(1).optional(),
  payload: z12.any().optional(),
  notes: z12.string().max(2e3).optional(),
  automation: automationSchema,
  candidateImage: candidateImageUpdateSchema,
  suggestedAction: reviewActionSchema.optional(),
  currentPublicImage: currentPublicImageSchema,
  evidenceFingerprint: z12.string().min(16).max(128).optional(),
  decisionReason: z12.string().max(1e3).nullable().optional(),
  reviewer: z12.string().max(200).nullable().optional(),
  decisionAt: z12.string().datetime().nullable().optional()
});
var reviewEditableFieldsSchema = z12.object({
  priority: z12.coerce.number().int().min(0).max(3).optional(),
  confidence: z12.coerce.number().min(0).max(1).optional(),
  payload: z12.any().optional(),
  notes: z12.string().max(2e3).optional(),
  automation: automationSchema,
  candidateImage: candidateImageUpdateSchema,
  suggestedAction: reviewActionSchema.optional(),
  currentPublicImage: currentPublicImageSchema,
  evidenceFingerprint: z12.string().min(16).max(128).optional()
}).strict();
var reviewQuerySchema = z12.object({
  status: queryReviewStatusSchema.optional(),
  type: reviewTypeSchema.optional(),
  riskType: reviewRiskTypeSchema.optional(),
  suggestedAction: reviewActionSchema.optional(),
  limit: z12.coerce.number().int().min(1).max(200).default(50),
  offset: z12.coerce.number().int().min(0).default(0)
});
var reviewDecisionQuerySchema = z12.object({
  figureId: z12.string().trim().min(1).optional(),
  figureSlug: z12.string().trim().min(1).optional(),
  riskType: reviewRiskTypeSchema.optional(),
  action: reviewActionSchema.optional(),
  limit: z12.coerce.number().int().min(1).max(200).default(50),
  offset: z12.coerce.number().int().min(0).default(0)
});
var bulkCleanupSchema = z12.object({
  dryRun: z12.boolean().default(false),
  markStale: z12.boolean().default(true),
  olderThanDays: z12.coerce.number().int().min(1).default(1)
});

// src/modules/reviews/apply-lock.ts
import crypto4 from "crypto";
var LOCK_TTL_MS = 6e4;
var RENEW_BEFORE_MS = 1e4;
var LOCK_LOST_ERR = "APPLY_LOCK_LOST";
var RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;
var RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;
var VERIFY_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return 1
end
return 0
`;
function lockKey(reviewItemId) {
  return `review:apply:lock:${reviewItemId}`;
}
function makeToken() {
  return crypto4.randomUUID();
}
async function verifyToken(redis, key, token) {
  try {
    const r = await redis.eval(VERIFY_SCRIPT, 1, key, token);
    return r === 1;
  } catch {
    return false;
  }
}
async function tryAcquire(redis, reviewItemId) {
  const key = lockKey(reviewItemId);
  const token = makeToken();
  const ok = await redis.set(key, token, "PX", LOCK_TTL_MS, "NX");
  if (ok !== "OK") return null;
  let lost = false;
  let renewed = true;
  const renewTimer = setInterval(async () => {
    if (!renewed) return;
    try {
      const r = await redis.eval(RENEW_SCRIPT, 1, key, token, String(LOCK_TTL_MS));
      if (r !== 1) {
        lost = true;
        renewed = false;
        clearInterval(renewTimer);
      }
    } catch {
      lost = true;
      renewed = false;
      clearInterval(renewTimer);
    }
  }, LOCK_TTL_MS - RENEW_BEFORE_MS);
  return {
    token,
    isLost() {
      return lost;
    },
    assertHeld() {
      if (lost) throw new Error(LOCK_LOST_ERR);
    },
    async verifyHeld(redis2) {
      const held = await verifyToken(redis2, key, token);
      if (!held) {
        lost = true;
        renewed = false;
        clearInterval(renewTimer);
        throw new Error(LOCK_LOST_ERR);
      }
    },
    async release() {
      renewed = false;
      clearInterval(renewTimer);
      try {
        const r = await redis.eval(RELEASE_SCRIPT, 1, key, token);
        return r === 1;
      } catch {
        return false;
      }
    }
  };
}

// src/modules/reviews/apply-errors.ts
var ReviewDomainError = class extends Error {
  constructor(code, message, statusCode = 422, stage) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.stage = stage;
    this.name = "ReviewDomainError";
  }
  code;
  statusCode;
  stage;
};
var ReviewNotFound = class extends ReviewDomainError {
  constructor(id) {
    super("REVIEW_NOT_FOUND", `Review item ${id} not found`, 404);
  }
};
var InvalidReviewState = class extends ReviewDomainError {
  constructor(current, expected) {
    super("INVALID_REVIEW_STATE", `Current status "${current}" is not valid. Required: ${expected}`, 409);
  }
};
var ApplyLockConflict = class extends ReviewDomainError {
  constructor(id) {
    super("APPLY_LOCK_CONFLICT", `Another apply is in progress for review item ${id}`, 409);
  }
};
var ApplyDependencyError = class extends ReviewDomainError {
  constructor(stage, message) {
    super("APPLY_DEPENDENCY_ERROR", `Apply failed at ${stage}: ${message}`, 422, stage);
  }
};
var ApplyValidationError = class extends ReviewDomainError {
  constructor(message) {
    super("APPLY_VALIDATION_ERROR", message, 422);
  }
};

// src/modules/reviews/apply-business.ts
async function resolveFigure(prisma, item) {
  const figureWhere = item.figureSlug ? { slug: item.figureSlug, isDeleted: false } : item.figureId ? { id: BigInt(item.figureId), isDeleted: false } : null;
  if (!figureWhere) return null;
  return prisma.figure.findFirst({ where: figureWhere });
}
async function applyFigureImport(context, item, id, actor, dto, action) {
  const { prisma } = context;
  const { images, categoryIds, sculptorIds, characterIds, localized, releases, importImages, ...figureFields } = dto;
  if (!figureFields.slug || !figureFields.name) {
    throw new ApplyValidationError("slug and name are required for figure_import");
  }
  const slugFig = figureFields.slug ? await prisma.figure.findFirst({ where: { slug: figureFields.slug, isDeleted: false }, select: { id: true, slug: true, janCode: true } }) : null;
  const janFig = figureFields.janCode ? await prisma.figure.findFirst({ where: { janCode: figureFields.janCode, isDeleted: false }, select: { id: true, slug: true, janCode: true } }) : null;
  if (slugFig && janFig && slugFig.id !== janFig.id) {
    throw new ApplyDependencyError("figure", "FIGURE_IDENTITY_CONFLICT: slug and JAN point to different figures");
  }
  const existingFigure = slugFig || janFig;
  const figureData = {
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
    hljId: figureFields.hljId ?? null
  };
  if (figureFields.releaseDate) {
    figureData.releaseDate = new Date(figureFields.releaseDate);
  }
  const relationData = {};
  if (categoryIds) {
    relationData.categories = { deleteMany: {}, create: categoryIds.map((categoryId) => ({ category: { connect: { id: categoryId } } })) };
  }
  if (sculptorIds) {
    relationData.sculptors = { deleteMany: {}, create: sculptorIds.map((s) => ({ sculptor: { connect: { id: s.id } }, role: s.role, isPrimary: s.isPrimary ?? false })) };
  }
  if (characterIds) {
    relationData.characters = { deleteMany: {}, create: characterIds.map((c) => ({ character: { connect: { id: c.id } }, isFeatured: c.isFeatured ?? false })) };
  }
  if (localized) {
    relationData.localized = { deleteMany: {}, create: localized.map((loc) => ({ language: loc.language, title: loc.title, origin: loc.origin, character: loc.character, description: loc.description })) };
  }
  if (releases) {
    relationData.releases = { deleteMany: {}, create: releases.map((rel) => ({ edition: rel.edition, releaseDate: rel.releaseDate ? new Date(rel.releaseDate) : void 0, priceJpy: rel.priceJpy ?? void 0, isRerelease: rel.isRerelease ?? false })) };
  }
  await context.verifyLock();
  const savedFigure = existingFigure ? await prisma.figure.update({ where: { id: existingFigure.id }, data: { ...figureData, ...relationData } }) : await prisma.figure.create({ data: { ...figureData, ...relationData } });
  const imageImport = { created: 0, errors: [] };
  if (importImages !== false && images && images.length > 0) {
    const janCode = figureFields.janCode || savedFigure.janCode || "no-jancode";
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        await context.verifyLock();
        const imageRecords = await processAndStoreImage2(img.source, janCode, prisma, {
          alt: img.alt,
          sortOrder: img.sortOrder ?? i,
          figureId: savedFigure.id
        });
        imageImport.created += imageRecords.length;
      } catch (err) {
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
    failure: allFailed ? { stage: "image", problems: ["All images failed to process"] } : void 0
  };
}
async function applyJanMatch(context, item, id, actor, dto, action) {
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
    select: { id: true, slug: true, janCode: true }
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
    select: { id: true }
  });
  return {
    success: true,
    action: "jan_matched",
    figure: { id: String(existing.id), slug: existing.slug }
  };
}
async function applyRewrite(context, item, id, actor, dto, action) {
  const { prisma } = context;
  const figure = await resolveFigure(prisma, item);
  if (!figure) {
    throw new ApplyDependencyError("revision", "FIGURE_NOT_FOUND");
  }
  const currentVersion = await prisma.revision.findFirst({
    where: { figureId: figure.id },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true }
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
      isActive: true
    },
    select: { id: true, versionNumber: true }
  });
  await context.verifyLock();
  await prisma.figure.update({
    where: { id: figure.id },
    data: { activeRevisionId: revision.id }
  });
  return {
    success: true,
    action: "rewrite_applied",
    figure: { id: String(figure.id), slug: figure.slug },
    revision: { id: String(revision.id), versionNumber: nextVersion }
  };
}
async function applyImage(context, item, id, actor, dto, action) {
  const { prisma } = context;
  const figure = await resolveFigure(prisma, item);
  if (!figure) {
    throw new ApplyDependencyError("image", "FIGURE_NOT_FOUND");
  }
  const janCode = figure.janCode || "no-jancode";
  let firstImageId = null;
  const imageImport = { created: 0, errors: [] };
  try {
    await context.verifyLock();
    const imageRecords = await processAndStoreImage2(dto.source, janCode, prisma, {
      alt: dto.alt,
      sortOrder: dto.sortOrder ?? 0,
      isNsfw: dto.isNsfw,
      figureId: figure.id
    });
    for (const rec of imageRecords) {
      if (firstImageId === null && rec.sha256) {
        await context.verifyLock();
        const result = await upsertFigureImageRecord2(prisma, {
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
          isNsfw: rec.isNsfw
        });
        firstImageId = String(result.image.id);
      }
    }
    imageImport.created = imageRecords.length;
  } catch (err) {
    imageImport.errors.push({ source: dto.source, error: err?.message || "Image processing failed" });
  }
  if (imageImport.errors.length > 0) {
    return {
      success: false,
      action: "image_failed",
      figure: { id: String(figure.id), slug: figure.slug },
      imageImport,
      failure: { stage: "image_download", problems: imageImport.errors.map((e) => e.error) }
    };
  }
  return {
    success: true,
    action: "image_imported",
    figure: { id: String(figure.id), slug: figure.slug },
    imageId: firstImageId,
    source: dto.source,
    processedCount: imageImport.created
  };
}
async function applyImageReview(context, item, id, actor, dto, action) {
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
    select: { id: true, source: true }
  });
  if (existing) {
    await context.verifyLock();
    await prisma.figureImage.update({
      where: { id: existing.id },
      data: {
        data: { source_kind: "mfc_review_approved", safe_display: true, image_low_quality: false, reviewed_by_admin: true, review_item_id: item.id },
        sortOrder: 0
      }
    });
    return { success: true, action: "already_approved", figure: { id: String(figure.id), slug: figure.slug }, imageId: String(existing.id), source: cand.source };
  }
  const janCode = figure.janCode || "no-jancode";
  let firstImageId = null;
  try {
    await context.verifyLock();
    const imageRecords = await processAndStoreImage2(cand.source, janCode, prisma, {
      sortOrder: 0,
      isNsfw: false,
      figureId: figure.id
    });
    for (const rec of imageRecords) {
      if (firstImageId === null && rec.sha256) {
        await context.verifyLock();
        const result = await upsertFigureImageRecord2(prisma, {
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
          isNsfw: rec.isNsfw
        });
        firstImageId = String(result.image.id);
      }
    }
  } catch (err) {
    return {
      success: false,
      action: "image_approve_failed",
      figure: { id: String(figure.id), slug: figure.slug },
      failure: { stage: "image_download", problems: [err?.message || "Image download/process failed"] }
    };
  }
  return { success: true, action: "image_approved", figure: { id: String(figure.id), slug: figure.slug }, imageId: firstImageId, source: cand.source, processedCount: firstImageId ? 1 : 0 };
}
async function applyItemStatus(context, id, item, output) {
  const problems = await evaluateReviewItem(context, item);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const businessFailed = output.failure || problems.length > 0;
  const newStatus = businessFailed ? "needs_changes" : "resolved";
  const updatedItem = {
    ...item,
    payload: { ...item.payload || {}, reviewProblems: problems, lastCheckedAt: now },
    status: newStatus,
    notes: problems.length === 0 ? item.notes ? `${item.notes}
Applied and rechecked at ${now}` : `Applied and rechecked at ${now}` : item.notes ? `${item.notes}
Applied but needs changes: ${problems.join("; ")}` : `Applied but needs changes: ${problems.join("; ")}`,
    updatedAt: now
  };
  await context.verifyLock();
  await context.redis.set(`review:item:${id}`, JSON.stringify(updatedItem));
  await context.verifyLock();
  await scanKeys(context.redis, "figures:*");
  return newStatus;
}
async function evaluateReviewItem(context, item) {
  const { prisma } = context;
  const payload = item.payload || {};
  const problems = [];
  const figure = await resolveFigure(prisma, item);
  if (["image", "image_review", "rewrite", "jan_match", "detail_review"].includes(item.type) && !figure) {
    problems.push("FIGURE_NOT_FOUND");
    return problems;
  }
  if (item.type === "image" && figure) {
    const rows = await prisma.figureImage.findMany({
      where: { figureId: figure.id },
      select: { id: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }]
    });
    if (rows.length === 0) problems.push("\u4ECD\u7136\u6CA1\u6709\u56FE\u7247");
  }
  if (item.type === "figure_import") {
    const slug = payload.figure?.slug || payload.slug || item.figureSlug;
    if (slug) {
      const existing = await prisma.figure.findFirst({ where: { slug: String(slug), isDeleted: false }, select: { id: true } });
      if (!existing) problems.push("\u5019\u9009\u624B\u529E\u4ECD\u672A\u5165\u5E93");
    } else {
      problems.push("\u5019\u9009\u5185\u5BB9\u7F3A\u5C11 slug");
    }
  }
  return problems;
}

// src/modules/reviews/apply-schemas.ts
import { z as z13 } from "zod";
var figureImportPayloadSchema = z13.object({
  slug: z13.string().min(1),
  name: z13.string().min(1),
  nameJp: z13.string().optional(),
  nameEn: z13.string().optional(),
  janCode: z13.string().optional(),
  scale: z13.string().optional(),
  material: z13.string().optional(),
  priceJpy: z13.number().int().optional(),
  releaseDate: z13.string().optional(),
  heightMm: z13.number().int().optional(),
  weightG: z13.number().int().optional(),
  description: z13.string().optional(),
  productLine: z13.string().optional(),
  mfcId: z13.string().optional(),
  ageRating: z13.string().optional(),
  hobbySearchId: z13.string().optional(),
  amiamiId: z13.string().optional(),
  hljId: z13.string().optional(),
  categoryIds: z13.array(z13.number().int()).optional(),
  sculptorIds: z13.array(z13.object({ id: z13.number().int(), role: z13.string().optional(), isPrimary: z13.boolean().optional() })).optional(),
  characterIds: z13.array(z13.object({ id: z13.number().int(), isFeatured: z13.boolean().optional() })).optional(),
  images: z13.array(z13.object({ source: z13.string(), alt: z13.string().optional(), sortOrder: z13.number().int().optional() })).optional(),
  localized: z13.array(z13.object({ language: z13.string(), title: z13.string().optional(), origin: z13.string().optional(), character: z13.string().optional(), description: z13.string().optional() })).optional(),
  releases: z13.array(z13.object({ edition: z13.string(), releaseDate: z13.string().optional(), priceJpy: z13.number().int().optional(), isRerelease: z13.boolean().optional() })).optional(),
  importImages: z13.boolean().optional()
}).strict();
var janMatchPayloadSchema = z13.object({
  janCode: z13.string().min(1),
  figureId: z13.union([z13.string(), z13.number()]).optional()
}).strict();
var rewritePayloadSchema = z13.object({
  description: z13.string().optional(),
  contentMd: z13.string().optional(),
  summaryMd: z13.string().optional(),
  keyPoints: z13.array(z13.string()).optional(),
  relatedKeywords: z13.array(z13.string()).optional(),
  editSummary: z13.string().optional()
}).strict();
var imagePayloadSchema = z13.object({
  source: z13.string(),
  alt: z13.string().optional(),
  sortOrder: z13.number().int().optional(),
  isNsfw: z13.boolean().optional()
}).strict();
var imageReviewPayloadSchema = z13.object({
  action: z13.enum(["approve_image", "reject_image", "keep_placeholder"]).optional()
}).strict();
var APPLY_TYPE_SCHEMA_MAP = {
  figure_import: figureImportPayloadSchema,
  jan_match: janMatchPayloadSchema,
  rewrite: rewritePayloadSchema,
  image: imagePayloadSchema,
  image_review: imageReviewPayloadSchema
};

// src/modules/reviews/apply-service.ts
function parseApplyBody(item, body) {
  const schema = APPLY_TYPE_SCHEMA_MAP[item.type];
  if (!schema) {
    throw new ApplyValidationError(`Unsupported review type: ${item.type}`);
  }
  const merged = { ...item.payload || {}, ...body };
  return schema.parse(merged);
}
var ReviewApplyService = class {
  constructor(redis, prisma) {
    this.redis = redis;
    this.prisma = prisma;
  }
  redis;
  prisma;
  async apply(input) {
    const { reviewItemId, actor, body } = input;
    const preRaw = await this.redis.get(`review:item:${reviewItemId}`);
    if (!preRaw) throw new ReviewNotFound(reviewItemId);
    const lease = await tryAcquire(this.redis, reviewItemId);
    if (!lease) throw new ApplyLockConflict(reviewItemId);
    try {
      lease.assertHeld();
      const raw = await this.redis.get(`review:item:${reviewItemId}`);
      if (!raw) throw new ReviewNotFound(reviewItemId);
      const item = JSON.parse(raw);
      if (item.status !== "pending" && item.status !== "needs_changes") {
        throw new InvalidReviewState(item.status, "pending or needs_changes");
      }
      lease.assertHeld();
      const dto = parseApplyBody(item, body);
      const context = {
        redis: this.redis,
        prisma: this.prisma,
        verifyLock: () => lease.verifyHeld(this.redis)
      };
      const action = String(body.action || item.suggestedAction || "approve_image");
      let output;
      switch (item.type) {
        case "figure_import":
          output = await applyFigureImport(context, item, reviewItemId, actor, dto, action);
          break;
        case "jan_match":
          output = await applyJanMatch(context, item, reviewItemId, actor, dto, action);
          break;
        case "rewrite":
          output = await applyRewrite(context, item, reviewItemId, actor, dto, action);
          break;
        case "image":
          output = await applyImage(context, item, reviewItemId, actor, dto, action);
          break;
        case "image_review":
          output = await applyImageReview(context, item, reviewItemId, actor, dto, action);
          break;
        default:
          throw new ApplyValidationError(`Unsupported review type: ${item.type}`);
      }
      const reviewStatus = await applyItemStatus(context, reviewItemId, item, output);
      return {
        success: output.failure ? false : true,
        data: { applied: output, reviewStatus, failureStage: output.failure?.stage || null, problems: output.failure?.problems || [] }
      };
    } catch (e) {
      if (e instanceof ReviewNotFound || e instanceof InvalidReviewState || e instanceof ApplyLockConflict || e instanceof ApplyDependencyError || e instanceof ApplyValidationError) {
        throw e;
      }
      throw new ApplyDependencyError(e.message || "Apply failed", "apply");
    } finally {
      await lease.release().catch(() => {
      });
    }
  }
};

// src/modules/reviews/apply-route.ts
async function adminApplyRoute(app) {
  const applyService = new ReviewApplyService(app.redis, app.prisma);
  app.post("/review/items/:id/apply", async (req, reply) => {
    try {
      const actor = {
        userId: String(req.user?.userId || req.user?.id || ""),
        displayName: String(req.user?.displayName || req.user?.username || "system")
      };
      const body = req.body || {};
      const result = await applyService.apply({
        reviewItemId: String(req.params.id),
        actor,
        body
      });
      const payload = result.data || {};
      if (result.success && payload.applied?.success !== false) {
        return reply.send({
          success: true,
          data: payload.applied,
          reviewStatus: payload.reviewStatus,
          actor,
          action: payload.applied?.action
        });
      }
      return reply.status(422).send({
        success: false,
        error: {
          code: "APPLY_BUSINESS_FAILED",
          message: "Apply completed with business failures",
          failureStage: payload.failureStage,
          problems: payload.problems,
          action: payload.applied?.action
        }
      });
    } catch (e) {
      if (e instanceof ReviewNotFound) return reply.status(404).send({ success: false, error: { code: e.code, message: e.message } });
      if (e instanceof InvalidReviewState) return reply.status(409).send({ success: false, error: { code: e.code, message: e.message } });
      if (e instanceof ApplyLockConflict) return reply.status(409).send({ success: false, error: { code: e.code, message: e.message } });
      if (e instanceof ApplyDependencyError) return reply.status(422).send({ success: false, error: { code: e.code, message: e.message, stage: e.stage } });
      if (e instanceof ApplyValidationError) return reply.status(422).send({ success: false, error: { code: e.code, message: e.message } });
      return reply.status(500).send({ success: false, error: { code: "APPLY_INTERNAL_ERROR", message: "Internal error during apply" } });
    }
  });
}

// src/modules/reviews/routes.ts
var ALL_STATUSES = "all";
var REVIEW_FORBIDDEN_UPDATE_FIELDS = /* @__PURE__ */ new Set(["status", "decisionReason", "reviewer", "decisionAt", "action", "createdAt"]);
async function resolveReviewFigure(prisma, item, payload) {
  const slug = item.figureSlug || payload.figureSlug || payload.slug || payload.figure?.slug;
  const id = item.figureId || payload.figureId || payload.figure?.id;
  if (id !== void 0 && id !== null && /^\d+$/.test(String(id))) {
    const byId = await prisma.figure.findFirst({ where: { id: BigInt(id), isDeleted: false }, select: { id: true, slug: true, name: true, janCode: true, activeRevisionId: true } });
    if (byId) return byId;
  }
  if (slug) return prisma.figure.findFirst({ where: { slug: String(slug), isDeleted: false }, select: { id: true, slug: true, name: true, janCode: true, activeRevisionId: true } });
  return null;
}
async function normalizeReviewItemForFingerprint(app, item) {
  const payload = item.payload || {};
  const resolved = await resolveReviewFigure(app.prisma, item, payload);
  if (!resolved) return { ...item, evidenceFingerprint: item.evidenceFingerprint || computeReviewEvidenceFingerprint(item) };
  const figure = await app.prisma.figure.findUnique({
    where: { id: resolved.id },
    select: { id: true, slug: true, description: true, scale: true, material: true, priceJpy: true, releaseDate: true, heightMm: true, weightG: true, productLine: true, ageRating: true, manufacturer: { select: { id: true, name: true } }, series: { select: { id: true, name: true } }, categories: { select: { categoryId: true }, orderBy: { categoryId: "asc" } }, images: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, source: true, sha256: true, width: true, height: true, size: true, sortOrder: true, data: true } } }
  });
  if (!figure) return { ...item, figureId: String(resolved.id), figureSlug: resolved.slug, evidenceFingerprint: item.evidenceFingerprint || computeReviewEvidenceFingerprint({ ...item, figureId: String(resolved.id), figureSlug: resolved.slug }) };
  const imageRows = (figure.images || []).map((im) => ({ id: String(im.id), source: im.source || null, sha256: im.sha256 || null, width: im.width ?? null, height: im.height ?? null, size: im.size || null, sortOrder: im.sortOrder ?? null, sourceKind: im.data && typeof im.data === "object" ? im.data.source_kind || null : null, safeDisplay: im.data && typeof im.data === "object" ? im.data.safe_display === true : false, imageLowQuality: im.data && typeof im.data === "object" ? im.data.image_low_quality === true : false }));
  const primary = imageRows[0] || null;
  const currentStateEvidence = { figure: { id: String(figure.id), slug: figure.slug }, images: { primaryImageId: primary?.id || null, imageIds: imageRows.map((i) => i.id).sort(), rows: imageRows }, detail: { description: figure.description || null, scale: figure.scale || null, material: figure.material || null, priceJpy: figure.priceJpy ?? null, releaseDate: figure.releaseDate ? figure.releaseDate.toISOString() : null, heightMm: figure.heightMm ?? null, weightG: figure.weightG ?? null, productLine: figure.productLine || null, ageRating: figure.ageRating || null, manufacturer: figure.manufacturer ? { id: String(figure.manufacturer.id), name: figure.manufacturer.name } : null, series: figure.series ? { id: String(figure.series.id), name: figure.series.name } : null, categories: (figure.categories || []).map((row) => String(row.categoryId)), specCount: [figure.scale, figure.material, figure.priceJpy, figure.releaseDate, figure.heightMm, figure.weightG, figure.productLine, figure.ageRating, figure.manufacturer?.name, figure.series?.name].filter((f) => f != null && String(f) !== "").length } };
  const normalized = { ...item, figureId: String(figure.id), figureSlug: figure.slug, currentStateEvidence, payload: { ...payload, submittedEvidenceFingerprint: item.evidenceFingerprint || payload.submittedEvidenceFingerprint || null, currentStateEvidence } };
  return { ...normalized, evidenceFingerprint: computeReviewEvidenceFingerprint(normalized) };
}
async function adminReviewRoutes(app) {
  await app.register(adminApplyRoute);
  app.get("/review/items", async (req) => {
    const query = reviewQuerySchema.parse(req.query || {});
    const statusFilter = query.status || "pending";
    const showAll = statusFilter === ALL_STATUSES;
    const ids = await app.redis.zrevrange("review:items", 0, -1);
    const filtered = [];
    for (const id of ids) {
      const raw = await app.redis.get("review:item:" + id);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        if (!showAll && item.status !== statusFilter) continue;
        if (query.type && item.type !== query.type) continue;
        if (query.riskType && item.riskType !== query.riskType) continue;
        if (query.suggestedAction && item.suggestedAction !== query.suggestedAction) continue;
        filtered.push(item);
      } catch {
      }
    }
    const total = filtered.length;
    const offset = query.offset || 0;
    const items = filtered.slice(offset, offset + query.limit);
    return { success: true, data: items, meta: { count: items.length, total, limit: query.limit, offset, defaultStatus: statusFilter } };
  });
  app.get("/review/decisions", async (req) => {
    const query = reviewDecisionQuerySchema.parse(req.query || {});
    let mappedFigureId;
    if (query.figureSlug) {
      const figure = await app.prisma.figure.findFirst({ where: { slug: query.figureSlug, isDeleted: false }, select: { id: true } });
      if (figure) mappedFigureId = String(figure.id);
    }
    const keys = await app.redis.zrevrange("review:decisions", 0, -1);
    const filtered = [];
    for (const key of keys) {
      if (!String(key).startsWith("review:decision:")) continue;
      const raw = await app.redis.get(key);
      if (!raw) continue;
      try {
        const decision = JSON.parse(raw);
        if (!reviewDecisionMatchesQuery(decision, query, mappedFigureId)) continue;
        filtered.push(projectReviewDecision(decision));
      } catch {
      }
    }
    const total = filtered.length;
    const offset = query.offset || 0;
    const data = filtered.slice(offset, offset + query.limit);
    return { success: true, data, meta: { count: data.length, total, limit: query.limit, offset } };
  });
  app.get("/review/stats", async () => {
    const ids = await app.redis.zrevrange("review:items", 0, -1);
    const stats = { total: 0, pending: 0, pending_image_review: 0, pending_detail_review: 0, pending_rewrite: 0, pending_figure_import: 0, stale: 0, resolved: 0, rejected: 0, approved: 0, needs_changes: 0, archived: 0 };
    for (const id of ids) {
      const raw = await app.redis.get("review:item:" + id);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        stats.total++;
        const s = item.status || "unknown";
        if (s === "pending") {
          stats.pending++;
          const t = item.type || "";
          if (t === "image_review") stats.pending_image_review++;
          else if (t === "detail_review") stats.pending_detail_review++;
          else if (t === "rewrite") stats.pending_rewrite++;
          else if (t === "figure_import") stats.pending_figure_import++;
        } else if (s === "stale") stats.stale++;
        else if (s === "resolved") stats.resolved++;
        else if (s === "rejected") stats.rejected++;
        else if (s === "approved") stats.approved++;
        else if (s === "needs_changes") stats.needs_changes++;
      } catch {
      }
    }
    stats.archived = await app.redis.zcard("review:archive");
    return { success: true, data: stats };
  });
  app.post("/review/items", async (req, reply) => {
    const data = reviewItemSchema.parse(req.body);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const candidateItem = await normalizeReviewItemForFingerprint(app, data);
    const dk = reviewDecisionKey(candidateItem);
    if (dk) {
      const decisionRaw = await app.redis.get(dk);
      if (decisionRaw) {
        try {
          const decision = JSON.parse(decisionRaw);
          return reply.status(200).send({ success: true, data: { ...candidateItem, id: null, status: "suppressed", suppressed: true, suppressionReason: "human_decision_exists", decision }, meta: { suppressed: true, reason: "human_decision_exists", decision } });
        } catch {
        }
      }
    }
    const ids = await app.redis.zrevrange("review:items", 0, -1);
    let existingPending = null;
    for (const pid of ids) {
      const raw = await app.redis.get("review:item:" + pid);
      if (!raw) continue;
      try {
        const item2 = JSON.parse(raw);
        if (item2.status !== "pending") continue;
        const ni = await normalizeReviewItemForFingerprint(app, item2);
        const fp3 = ni.evidenceFingerprint || computeReviewEvidenceFingerprint(ni);
        const rt = reviewRiskKey(ni);
        const fk = reviewFigureKey(ni);
        if (fp3 === dk && rt === reviewRiskKey(candidateItem) && fk === reviewFigureKey(candidateItem)) {
          existingPending = item2;
          break;
        }
      } catch {
      }
    }
    if (existingPending) return reply.status(200).send({ success: true, data: existingPending, meta: { duplicate: true, reason: "pending_review_exists" } });
    const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const item = { id, ...candidateItem, createdAt: now, updatedAt: now };
    await app.redis.set("review:item:" + id, JSON.stringify(item));
    await app.redis.zadd("review:items", Date.now(), id);
    return reply.status(201).send({ success: true, data: item });
  });
  app.put("/review/items/:id", async (req, reply) => {
    const { id } = req.params;
    const existingRaw = await app.redis.get("review:item:" + id);
    if (!existingRaw) return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
    const body = req.body || {};
    const forbiddenKeys = Object.keys(body).filter((k) => REVIEW_FORBIDDEN_UPDATE_FIELDS.has(k));
    if (forbiddenKeys.length > 0) return reply.status(422).send({ success: false, error: { code: "FORBIDDEN_FIELDS", message: "Cannot modify review state via generic update: " + forbiddenKeys.join(", ") + ". Use /action endpoint.", fields: forbiddenKeys } });
    const update = reviewEditableFieldsSchema.strict().parse(body);
    const existing = JSON.parse(existingRaw);
    const item = { ...existing, ...update, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    const versionChanged = existing.version !== void 0 && item.version !== existing.version;
    if (versionChanged) return reply.status(409).send({ success: false, error: { code: "VERSION_CONFLICT", message: "Item version has changed" } });
    await app.redis.set("review:item:" + id, JSON.stringify(item));
    return { success: true, data: item };
  });
  app.post("/review/items/:id/recheck", async (req, reply) => {
    const { id } = req.params;
    const existingRaw = await app.redis.get("review:item:" + id);
    if (!existingRaw) return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
    const item = JSON.parse(existingRaw);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const problems = [];
    const payload = item.payload || {};
    const figure = await resolveReviewFigure(app.prisma, item, payload);
    if (["image", "image_review", "rewrite", "jan_match", "detail_review"].includes(item.type) && !figure) problems.push("FIGURE_NOT_FOUND");
    if (item.type === "image" && figure) {
      const rows = await app.prisma.figureImage.findMany({ where: { figureId: figure.id }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
      if (rows.length === 0) problems.push("\u4ECD\u7136\u6CA1\u6709\u56FE\u7247");
    }
    const hasDeterministicProblem = problems.length > 0 && !problems.some((p) => p.includes("\u9700\u4EBA\u5DE5\u5224\u65AD"));
    const newStatus = problems.length === 0 ? "resolved" : hasDeterministicProblem ? "needs_changes" : item.status;
    const noteText = problems.length === 0 ? "\u590D\u68C0\u901A\u8FC7\uFF1A" + now : "\u590D\u68C0\u4ECD\u6709\u95EE\u9898\uFF1A" + problems.join(";");
    const updatedItem = { ...item, payload: { ...item.payload || {}, reviewProblems: problems, lastCheckedAt: now }, status: newStatus, notes: item.notes ? item.notes + "\n" + noteText : noteText, updatedAt: now };
    await app.redis.set("review:item:" + id, JSON.stringify(updatedItem));
    return { success: true, data: { item: updatedItem, problems } };
  });
  app.post("/review/items/:id/action", async (req, reply) => {
    const { id } = req.params;
    const actionBody = reviewActionSchema.parse((req.body || {}).action);
    const existingRaw = await app.redis.get("review:item:" + id);
    if (!existingRaw) return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
    const item = JSON.parse(existingRaw);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const newStatus = ACTION_STATUS_MAP[actionBody] || item.status;
    const actionNote = ACTION_STATUS_MAP[actionBody] ? actionBody : item.status;
    const reviewer = req.user?.displayName || String(req.user?.userId || "");
    const note = (reviewer ? "[" + reviewer + "] " : "") + "\u7BA1\u7406\u5458" + actionNote;
    const userNote = (req.body || {}).notes ? "\uFF08" + (req.body || {}).notes + "\uFF09" : "";
    const isFinal = isSuppressingAction(actionBody);
    const updatedItem = { ...item, status: newStatus, evidenceFingerprint: item.evidenceFingerprint || computeReviewEvidenceFingerprint(item), decisionReason: isFinal ? (req.body || {}).notes || null : item.decisionReason, reviewer: isFinal ? reviewer || null : item.reviewer, decisionAt: isFinal ? now : item.decisionAt, notes: item.notes ? item.notes + "\n[" + now + "] " + note + userNote : "[" + now + "] " + note + userNote, payload: { ...item.payload || {}, lastAction: actionBody, lastActionAt: now, evidenceFingerprint: item.evidenceFingerprint || computeReviewEvidenceFingerprint(item) }, updatedAt: now };
    updatedItem.evidenceFingerprint = updatedItem.evidenceFingerprint || computeReviewEvidenceFingerprint(updatedItem);
    await app.redis.set("review:item:" + id, JSON.stringify(updatedItem));
    if (isFinal) {
      const dk = reviewDecisionKey(updatedItem);
      if (dk) {
        const decision = { reviewItemId: id, figure: reviewFigureKey(updatedItem), type: updatedItem.type || "general", riskType: reviewRiskKey(updatedItem), evidenceFingerprint: updatedItem.evidenceFingerprint || "", action: actionBody, status: newStatus, reviewer: reviewer || null, decisionReason: (req.body || {}).notes || null, decisionAt: now };
        await app.redis.set(dk, JSON.stringify(decision));
        await app.redis.zadd("review:decisions", Date.now(), dk);
      }
    }
    if (actionBody === "request_refetch") {
      const fid = item.figureId ? String(item.figureId) : null;
      const jobId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const job = { id: jobId, attempts: 0, source: "manual", task: "fetch_item", runner: "local_browser", status: "queued", priority: 2, payload: { figureId: fid, figureSlug: item.figureSlug || "", reason: item.riskReason || "Refetch from review", reviewItemId: id, needImages: item.type !== "detail_review", needDetails: item.type === "detail_review" }, notes: "Created from review action", notBefore: (/* @__PURE__ */ new Date()).toISOString(), maxAttempts: 3, automation: { provider: "manual", workflow: "review-refetch" }, createdAt: now, updatedAt: now };
      await app.redis.set("crawler:job:" + jobId, JSON.stringify(job));
      await app.redis.zadd("crawler:jobs", Date.now() + 2 * 1e9, jobId);
      updatedItem.payload = { ...updatedItem.payload || {}, crawlerJobId: jobId };
      await app.redis.set("review:item:" + id, JSON.stringify(updatedItem));
    }
    if (["approve_image", "reject_image", "keep_placeholder"].includes(actionBody) && item.figureSlug) {
      await scanKeys(app.redis, "figures:detail:*");
    }
    return { success: true, data: { item: updatedItem, action: actionBody } };
  });
  app.post("/review/items/bulk/cleanup", async (req, reply) => {
    const body = bulkCleanupSchema.parse(req.body || {});
    const cutoff = Date.now() - body.olderThanDays * 864e5;
    const ids = await app.redis.zrevrange("review:items", 0, -1);
    const updated = [];
    const skipped = [];
    for (const bid of ids) {
      const raw = await app.redis.get("review:item:" + bid);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        if (item.type !== "rewrite" || item.source !== "localized-description-sync") {
          skipped.push(bid);
          continue;
        }
        if (item.status !== "resolved" && item.status !== "stale") {
          skipped.push(bid);
          continue;
        }
        const ts = Date.parse(item.updatedAt || item.createdAt || "");
        if (isNaN(ts) || ts > cutoff) {
          skipped.push(bid);
          continue;
        }
        if (body.dryRun) {
          updated.push(bid);
          continue;
        }
        if (body.markStale && item.status !== "stale") {
          const nnow = (/* @__PURE__ */ new Date()).toISOString();
          item.status = "stale";
          item.notes = item.notes ? item.notes + "\n[" + nnow + "] \u81EA\u52A8\u6E05\u7406\uFF1A\u5DF2 resolved \u7684\u65E7 rewrite \u9879\u6807\u8BB0\u4E3A stale" : "[" + nnow + "] \u81EA\u52A8\u6E05\u7406\uFF1A\u5DF2 resolved \u7684\u65E7 rewrite \u9879\u6807\u8BB0\u4E3A stale";
          item.updatedAt = nnow;
          await app.redis.set("review:item:" + bid, JSON.stringify(item));
        }
        updated.push(bid);
      } catch {
      }
    }
    return { success: true, data: { updatedCount: updated.length, skippedCount: skipped.length, totalScanned: ids.length, dryRun: body.dryRun, sampleUpdated: updated.slice(0, 5) } };
  });
}

// src/modules/admin-aigc/routes.ts
import { z as z14 } from "zod";
var aigcGenerateSchema = z14.object({
  figureId: z14.string().regex(/^\d+$/, "Figure ID must be a decimal string").transform((val) => BigInt(val)),
  locale: z14.enum(["ja", "en", "zh"]).default("en"),
  promptVersion: z14.string().optional()
});
var aigcStatusParamsSchema = z14.object({
  figureId: z14.string().regex(/^\d+$/, "Figure ID must be a decimal string")
});
async function adminAigcRoutes(app) {
  app.post("/aigc/generate", async (req, reply) => {
    const data = aigcGenerateSchema.parse(req.body);
    const locale = data.locale || "en";
    const promptVersion = data.promptVersion || "v1";
    const idStr = data.figureId.toString();
    const entry = JSON.stringify({ figureId: idStr, locale, promptVersion, createdAt: (/* @__PURE__ */ new Date()).toISOString() });
    await app.redis.rpush("aigc:queue", entry);
    return reply.status(201).send({ success: true, data: { figureId: idStr, locale, promptVersion, status: "queued" } });
  });
  app.get("/aigc/status/:figureId", async (req, reply) => {
    const { figureId } = aigcStatusParamsSchema.parse(req.params);
    const resultRaw = await app.redis.get(`aigc:result:${figureId}`);
    if (resultRaw) {
      try {
        const result = JSON.parse(resultRaw);
        return { success: true, data: { figureId, status: "completed", result } };
      } catch {
        return { success: true, data: { figureId, status: "completed", result: resultRaw } };
      }
    }
    const queue = await app.redis.lrange("aigc:queue", 0, -1);
    const inQueue = queue.some((entry) => {
      try {
        const parsed = JSON.parse(entry);
        return parsed.figureId === figureId;
      } catch {
        return false;
      }
    });
    if (inQueue) {
      return { success: true, data: { figureId, status: "queued" } };
    }
    return { success: true, data: { figureId, status: "not_found" } };
  });
}

// src/modules/admin-stats/routes.ts
async function adminStatsRoutes(app) {
  app.get("/stats", async () => {
    const [figures, manufacturers, series, sculptors, categories, characters, users, images] = await Promise.all([
      app.prisma.figure.count({ where: { isDeleted: false } }),
      app.prisma.manufacturer.count(),
      app.prisma.series.count(),
      app.prisma.sculptor.count(),
      app.prisma.category.count(),
      app.prisma.character.count(),
      app.prisma.user.count(),
      app.prisma.figureImage.count()
    ]);
    const [recentFigures, upcomingReleases, topManufacturers] = await Promise.all([
      app.prisma.figure.findMany({ where: { isDeleted: false }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, slug: true, name: true, nameEn: true, createdAt: true } }),
      app.prisma.figure.findMany({ where: { isDeleted: false, releaseDate: { gte: /* @__PURE__ */ new Date() } }, orderBy: { releaseDate: "asc" }, take: 5, select: { id: true, slug: true, name: true, nameEn: true, releaseDate: true, priceJpy: true } }),
      app.prisma.manufacturer.findMany({ orderBy: { figures: { _count: "desc" } }, take: 10, select: { id: true, slug: true, name: true, _count: { select: { figures: true } } } })
    ]);
    return { success: true, data: { counts: { figures, manufacturers, series, sculptors, categories, characters, users, images }, recentFigures, upcomingReleases, topManufacturers } };
  });
}

// src/modules/admin-image-proxy/routes.ts
import { z as z15 } from "zod";
async function adminImageProxyRoutes(app) {
  app.get("/review/image-proxy", { config: { rateLimit: { max: 100, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!req.user || !req.user.role) return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED", message: "Admin auth required" } });
    const { url } = z15.object({ url: z15.string() }).parse(req.query);
    const urlCheck = await validateImageUrl(url);
    if (!urlCheck.ok) return reply.status(422).send({ success: false, error: { code: "URL_BLOCKED", message: urlCheck.reason || "URL not allowed" } });
    try {
      const result = await downloadImage(url);
      const ct = (result.contentType || "image/jpeg").toLowerCase();
      if (!ct.startsWith("image/")) return reply.status(422).send({ success: false, error: { code: "NOT_IMAGE", message: "URL does not point to an image" } });
      reply.header("Content-Type", ct);
      reply.header("Content-Length", result.buffer.length);
      reply.header("Cache-Control", "private, max-age=300");
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(result.buffer);
    } catch (err) {
      return reply.status(422).send({ success: false, error: { code: "IMAGE_PROXY_FAILED", message: err.message || "Failed to fetch image" } });
    }
  });
}

// src/modules/admin-cache-candidate/routes.ts
import fsp from "fs/promises";
import path3 from "path";
import sharp3 from "sharp";
import crypto5 from "crypto";
async function adminCacheCandidateRoutes(app) {
  const REVIEW_CACHE_DIR = process.env.REVIEW_CACHE_DIR || "/app/assets/review-cache";
  app.post(
    "/review/cache-candidate",
    { preHandler: [async (req, reply) => {
      if (!req.user || !req.user.role) {
        return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
      }
    }] },
    async (req, reply) => {
      const signingSecret = process.env.REVIEW_CACHE_SIGNING_SECRET;
      if (!signingSecret) {
        return reply.status(500).send({ success: false, error: { code: "SIGNING_NOT_CONFIGURED", message: "REVIEW_CACHE_SIGNING_SECRET is not set" } });
      }
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
      let meta, fileExt;
      try {
        meta = await sharp3(buf).metadata();
        if (!meta.format || !["jpeg", "png", "webp"].includes(meta.format)) {
          return reply.status(422).send({ success: false, error: { code: "NOT_IMAGE" } });
        }
        fileExt = meta.format === "jpeg" ? "jpg" : meta.format;
      } catch {
        return reply.status(422).send({ success: false, error: { code: "NOT_IMAGE" } });
      }
      const actualHash = crypto5.createHash("sha256").update(buf).digest("hex");
      if (actualHash !== hash.toLowerCase()) {
        return reply.status(422).send({ success: false, error: { code: "HASH_MISMATCH", message: "Content sha256 does not match submitted hash" } });
      }
      const reEncoded = await sharp3(buf).rotate().toFormat(meta.format || "jpeg", { quality: 90 }).toBuffer();
      const normalizedHash = crypto5.createHash("sha256").update(reEncoded).digest("hex");
      const reviewDir = path3.join(REVIEW_CACHE_DIR, reviewId);
      const resolved = path3.resolve(reviewDir);
      const cacheRoot = path3.resolve(REVIEW_CACHE_DIR);
      if (!resolved.startsWith(cacheRoot + path3.sep) && resolved !== cacheRoot) {
        return reply.status(422).send({ success: false, error: { code: "PATH_TRAVERSAL" } });
      }
      await fsp.mkdir(reviewDir, { recursive: true });
      const fileName = normalizedHash + "." + fileExt;
      const filePath = path3.join(reviewDir, fileName);
      const tmpPath = filePath + ".tmp." + crypto5.randomBytes(8).toString("hex");
      try {
        await fsp.writeFile(tmpPath, reEncoded);
        await fsp.rename(tmpPath, filePath);
      } catch (writeErr) {
        try {
          await fsp.unlink(tmpPath);
        } catch {
        }
        return reply.status(500).send({ success: false, error: { code: "FILE_WRITE_FAILED", message: writeErr?.message || "Failed to write cache file" } });
      }
      const maxTtl = 864e5;
      const expiresAt = Math.floor(Date.now() + maxTtl);
      const signPayload = `${reviewId}/${fileName}:${expiresAt}`;
      const sig = crypto5.createHmac("sha256", signingSecret).update(signPayload).digest("hex");
      return reply.status(201).send({
        success: true,
        data: { reviewId, hash: normalizedHash, ext: fileExt, url: `/api/v1/review/cached-image/${reviewId}/${fileName}?exp=${expiresAt}&sig=${sig}` }
      });
    }
  );
}

// src/routes/admin.ts
Object.defineProperty(BigInt.prototype, "toJSON", {
  value: function() {
    return this.toString();
  },
  writable: true,
  configurable: true
});
var aigcSchema = z16.object({
  figureId: z16.number().int().positive(),
  locale: z16.enum(["ja", "en", "zh"]).default("en"),
  promptVersion: z16.string().optional()
});
var updateUserSchema2 = z16.object({
  displayName: z16.string().min(1).optional(),
  role: z16.enum(["admin", "editor", "viewer"]).optional(),
  isActive: z16.boolean().optional()
});
var reviewStatusSchema3 = z16.enum(["pending", "approved", "rejected", "needs_changes", "resolved", "stale"]);
var queryReviewStatusSchema2 = z16.union([reviewStatusSchema3, z16.literal("all")]);
var reviewTypeSchema2 = z16.enum(["jan_match", "figure_import", "rewrite", "image", "general", "image_review", "detail_review"]);
var reviewRiskTypeSchema2 = z16.enum([
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
  "general_risk"
]);
var reviewActionSchema2 = z16.enum([
  "approve_image",
  "reject_image",
  "keep_placeholder",
  "mark_detail_ok",
  "request_refetch",
  "dismiss_stale",
  "keep_pending"
]);
var reviewItemSchema2 = z16.object({
  type: reviewTypeSchema2.default("general"),
  title: z16.string().min(1),
  source: z16.string().optional(),
  sourceId: z16.string().optional(),
  status: reviewStatusSchema3.default("pending"),
  priority: z16.coerce.number().int().min(0).max(3).default(1),
  confidence: z16.coerce.number().min(0).max(1).optional(),
  figureId: z16.union([z16.number().int(), z16.string()]).optional(),
  figureSlug: z16.string().optional(),
  // Track RQ: risk metadata for crawler/agent uncertain content
  riskType: reviewRiskTypeSchema2.optional(),
  riskReason: z16.string().max(1e3).optional(),
  candidateImage: z16.object({
    source: z16.string(),
    imageId: z16.union([z16.number(), z16.string()]).optional(),
    width: z16.number().int().optional(),
    height: z16.number().int().optional(),
    fileSize: z16.number().int().optional(),
    aspectRatio: z16.number().optional(),
    url: z16.string().optional(),
    cachedUrl: z16.string().optional()
  }).passthrough().optional(),
  currentPublicImage: z16.object({
    imageId: z16.union([z16.number(), z16.string()]).optional(),
    source: z16.string().optional(),
    width: z16.number().int().optional(),
    height: z16.number().int().optional()
  }).optional(),
  detailSnapshot: z16.object({
    description: z16.string().optional(),
    specCount: z16.number().int().optional(),
    specs: z16.any().optional(),
    categories: z16.array(z16.any()).optional()
  }).optional(),
  suggestedAction: reviewActionSchema2.optional(),
  payload: z16.any().optional(),
  notes: z16.string().optional(),
  automation: z16.object({
    provider: z16.enum(["n8n", "hermes", "manual", "other"]).default("manual"),
    workflow: z16.string().optional(),
    runId: z16.string().optional()
  }).optional()
});
var candidateImageUpdateSchema2 = z16.object({
  source: z16.string(),
  imageId: z16.union([z16.number(), z16.string()]).optional(),
  width: z16.number().int().optional(),
  height: z16.number().int().optional(),
  fileSize: z16.number().int().optional(),
  aspectRatio: z16.number().optional(),
  url: z16.string().optional(),
  cachedUrl: z16.string().optional()
}).passthrough().optional();
var reviewUpdateSchema3 = z16.object({
  status: reviewStatusSchema3.optional(),
  priority: z16.coerce.number().int().min(0).max(3).optional(),
  confidence: z16.coerce.number().min(0).max(1).optional(),
  payload: z16.any().optional(),
  notes: z16.string().max(2e3).optional(),
  automation: z16.object({
    provider: z16.enum(["n8n", "hermes", "manual", "other"]).default("manual"),
    workflow: z16.string().optional(),
    runId: z16.string().optional()
  }).optional(),
  candidateImage: candidateImageUpdateSchema2,
  suggestedAction: reviewActionSchema2.optional(),
  currentPublicImage: z16.object({
    imageId: z16.union([z16.number(), z16.string()]).optional(),
    source: z16.string().optional(),
    width: z16.number().int().optional(),
    height: z16.number().int().optional()
  }).optional()
});
var reviewQuerySchema2 = z16.object({
  status: queryReviewStatusSchema2.optional(),
  type: reviewTypeSchema2.optional(),
  riskType: reviewRiskTypeSchema2.optional(),
  suggestedAction: reviewActionSchema2.optional(),
  limit: z16.coerce.number().int().min(1).max(200).default(50),
  offset: z16.coerce.number().int().min(0).default(0)
});
var crawlerRunnerSchema2 = z16.enum(["server_safe", "local_browser", "proxy_browser", "manual"]);
var crawlerJobStatusSchema2 = z16.enum(["queued", "claimed", "running", "succeeded", "failed", "deferred", "cancelled"]);
var crawlerJobSchema2 = z16.object({
  source: z16.string().min(1),
  task: z16.string().min(1),
  runner: crawlerRunnerSchema2.default("server_safe"),
  status: crawlerJobStatusSchema2.default("queued"),
  priority: z16.coerce.number().int().min(0).max(3).default(1),
  payload: z16.any().optional(),
  notBefore: z16.string().datetime().optional(),
  maxAttempts: z16.coerce.number().int().min(1).max(10).default(3),
  notes: z16.string().optional(),
  automation: z16.object({
    provider: z16.enum(["n8n", "hermes", "manual", "other"]).default("manual"),
    workflow: z16.string().optional(),
    runId: z16.string().optional()
  }).optional()
});
var crawlerJobUpdateSchema2 = z16.object({
  status: crawlerJobStatusSchema2.optional(),
  runner: crawlerRunnerSchema2.optional(),
  priority: z16.coerce.number().int().min(0).max(3).optional(),
  payload: z16.any().optional(),
  result: z16.any().optional(),
  resultSummary: z16.any().optional(),
  error: z16.string().optional(),
  notes: z16.string().optional(),
  notBefore: z16.string().datetime().nullable().optional()
});
var crawlerJobQuerySchema2 = z16.object({
  status: crawlerJobStatusSchema2.optional(),
  runner: crawlerRunnerSchema2.optional(),
  source: z16.string().optional(),
  limit: z16.coerce.number().int().min(1).max(200).default(50)
});
var crawlerClaimSchema2 = z16.object({
  runner: crawlerRunnerSchema2,
  workerId: z16.string().min(1),
  limit: z16.coerce.number().int().min(1).max(10).default(1)
});
async function adminRoutes(app) {
  const CACHE_ALLOWLIST3 = [
    "figures:detail:*",
    "figures:list:*",
    "search:*",
    "homepage:*"
  ];
  const BLOCKED_NAMESPACES2 = ["review:", "crawler:", "session:", "rate-limit:"];
  function isAllowedPattern3(p) {
    if (!p || typeof p !== "string") return false;
    for (const blocked of BLOCKED_NAMESPACES2) {
      if (p.startsWith(blocked) || p.includes(blocked)) return false;
    }
    for (const allowed of CACHE_ALLOWLIST3) {
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
  await app.register(adminCacheCandidateRoutes);
}

// src/routes/auth.ts
import { z as z17 } from "zod";
import bcrypt2 from "bcryptjs";
import crypto6 from "crypto";
import nodemailer from "nodemailer";
var PASSWORD_RULES = {
  minLength: 8,
  maxLength: 128,
  upper: /[A-Z]/,
  lower: /[a-z]/,
  special: /[^A-Za-z0-9]/
};
function passwordIssues(password) {
  const issues = [];
  if (password.length < PASSWORD_RULES.minLength) issues.push(`\u81F3\u5C11 ${PASSWORD_RULES.minLength} \u4E2A\u5B57\u7B26`);
  if (password.length > PASSWORD_RULES.maxLength) issues.push(`\u4E0D\u80FD\u8D85\u8FC7 ${PASSWORD_RULES.maxLength} \u4E2A\u5B57\u7B26`);
  if (!PASSWORD_RULES.upper.test(password)) issues.push("\u81F3\u5C11 1 \u4E2A\u5927\u5199\u5B57\u6BCD");
  if (!PASSWORD_RULES.lower.test(password)) issues.push("\u81F3\u5C11 1 \u4E2A\u5C0F\u5199\u5B57\u6BCD");
  if (!PASSWORD_RULES.special.test(password)) issues.push("\u81F3\u5C11 1 \u4E2A\u7279\u6B8A\u5B57\u7B26");
  return issues;
}
var passwordSchema = z17.string().superRefine((password, ctx) => {
  const issues = passwordIssues(password);
  if (issues.length > 0) {
    ctx.addIssue({
      code: z17.ZodIssueCode.custom,
      message: `\u5BC6\u7801\u5F3A\u5EA6\u4E0D\u8DB3\uFF1A${issues.join("\u3001")}`
    });
  }
});
var registerSchema2 = z17.object({
  email: z17.string().email(),
  password: passwordSchema,
  displayName: z17.string().trim().min(1).max(40),
  website: z17.string().max(0).optional()
});
var loginSchema = z17.object({
  username: z17.string().min(1).optional(),
  email: z17.string().email().optional(),
  password: z17.string().min(1)
}).refine((data) => data.username || data.email, {
  message: "Either username or email is required"
});
var changePasswordSchema = z17.object({
  currentPassword: z17.string().min(1),
  newPassword: passwordSchema
  // 安全：复用前端相同的强度规则
});
var verifyEmailSchema = z17.object({
  token: z17.string().min(24)
});
function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || "unknown";
}
function tokenHash(token) {
  return crypto6.createHash("sha256").update(token).digest("hex");
}
function siteUrl(req) {
  const configured = process.env.SITE_URL || process.env.MW_SITE_URL || process.env.PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "www.phoebusstudio.com";
  return `${proto}://${host}`.replace(/\/$/, "");
}
async function hitLimit(app, key, limit, windowSeconds) {
  const current = await app.redis.incr(key);
  if (current === 1) await app.redis.expire(key, windowSeconds);
  return current > limit;
}
function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}
async function sendVerificationEmail(to, displayName, verifyUrl) {
  if (!smtpConfigured()) {
    throw new Error("SMTP_NOT_CONFIGURED");
  }
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  const auth = process.env.SMTP_USER && process.env.SMTP_PASS ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : void 0;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: "Activate your ModelWiki account",
    text: [
      `Hi ${displayName},`,
      "",
      "Please activate your ModelWiki account by opening this link:",
      verifyUrl,
      "",
      "This link expires in 24 hours. If you did not create this account, you can ignore this email."
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222">
        <h2>Activate your ModelWiki account</h2>
        <p>Hi ${displayName.replace(/[<>&"]/g, "")},</p>
        <p>Please confirm your email address before logging in.</p>
        <p><a href="${verifyUrl}" style="display:inline-block;background:#e94560;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Activate account</a></p>
        <p style="color:#666;font-size:13px">This link expires in 24 hours. If the button does not work, copy this URL:<br>${verifyUrl}</p>
      </div>
    `
  });
}
async function authRoutes(app) {
  const prisma = app.prisma;
  app.post("/register", { config: { rateLimit: { max: 3, timeWindow: "15 minutes" } } }, async (req, reply) => {
    if (process.env.ENABLE_PUBLIC_REGISTRATION === "false") {
      return reply.status(403).send({ success: false, error: { code: "REGISTRATION_DISABLED", message: "Public registration is disabled" } });
    }
    const { email, password, displayName, website } = registerSchema2.parse(req.body);
    if (website) {
      return reply.status(400).send({ success: false, error: { code: "INVALID_REGISTRATION", message: "\u6CE8\u518C\u8BF7\u6C42\u65E0\u6548" } });
    }
    if (!smtpConfigured()) {
      return reply.status(503).send({ success: false, error: { code: "EMAIL_NOT_CONFIGURED", message: "\u90AE\u4EF6\u670D\u52A1\u672A\u914D\u7F6E\uFF0C\u6682\u65F6\u65E0\u6CD5\u6CE8\u518C" } });
    }
    const ip = clientIp(req);
    const normalizedEmail = email.toLowerCase();
    const [ipLimited, emailLimited] = await Promise.all([
      hitLimit(app, `auth:register:ip:${ip}`, 3, 15 * 60),
      hitLimit(app, `auth:register:email:${normalizedEmail}`, 3, 30 * 60)
    ]);
    if (ipLimited || emailLimited) {
      return reply.status(429).send({ success: false, error: { code: "REGISTER_RATE_LIMITED", message: "\u6CE8\u518C\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5" } });
    }
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing?.emailVerifiedAt) {
      return reply.status(409).send({ success: false, error: { code: "EMAIL_EXISTS", message: "Email already registered" } });
    }
    const rawToken = crypto6.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1e3);
    const passwordHash = await bcrypt2.hash(password, 12);
    const user = existing ? await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, displayName, isActive: false, emailVerifyTokenHash: tokenHash(rawToken), emailVerifyExpiresAt: expiresAt },
      select: { id: true, email: true, displayName: true, role: true, isActive: true, createdAt: true }
    }) : await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        displayName,
        isActive: false,
        emailVerifyTokenHash: tokenHash(rawToken),
        emailVerifyExpiresAt: expiresAt
      },
      select: { id: true, email: true, displayName: true, role: true, isActive: true, createdAt: true }
    });
    const verifyUrl = `${siteUrl(req)}/api/v1/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
    try {
      await sendVerificationEmail(normalizedEmail, displayName, verifyUrl);
    } catch (err) {
      app.log.error({ err, email: normalizedEmail }, "Failed to send verification email");
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {
      });
      return reply.status(503).send({ success: false, error: { code: "EMAIL_SEND_FAILED", message: "\u6FC0\u6D3B\u90AE\u4EF6\u53D1\u9001\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5" } });
    }
    return reply.status(201).send({
      success: true,
      data: { user, requiresEmailVerification: true },
      message: "\u6CE8\u518C\u6210\u529F\uFF0C\u8BF7\u68C0\u67E5\u90AE\u7BB1\u5E76\u70B9\u51FB\u6FC0\u6D3B\u94FE\u63A5\u540E\u518D\u767B\u5F55"
    });
  });
  app.get("/verify-email", async (req, reply) => {
    const { token } = verifyEmailSchema.parse(req.query || {});
    const user = await prisma.user.findFirst({
      where: {
        emailVerifyTokenHash: tokenHash(token),
        emailVerifyExpiresAt: { gt: /* @__PURE__ */ new Date() }
      },
      select: { id: true }
    });
    if (!user) {
      return reply.type("text/html; charset=utf-8").status(400).send("<h1>Activation link is invalid or expired.</h1><p>Please register again to receive a new activation email.</p>");
    }
    await prisma.user.update({
      where: { id: user.id },
      data: {
        isActive: true,
        emailVerifiedAt: /* @__PURE__ */ new Date(),
        emailVerifyTokenHash: null,
        emailVerifyExpiresAt: null
      }
    });
    return reply.type("text/html; charset=utf-8").send('<h1>Account activated.</h1><p>You can now <a href="/account/">log in to ModelWiki</a>.</p>');
  });
  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { username, email, password } = loginSchema.parse(req.body);
    let user;
    if (username) {
      user = await prisma.user.findFirst({
        where: {
          OR: [
            { email: username.toLowerCase() },
            { displayName: { equals: username } }
          ]
        }
      });
    } else if (email) {
      user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    }
    if (!user) {
      return reply.status(401).send({ success: false, error: { code: "INVALID_CREDENTIALS", message: "\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF" } });
    }
    if (!user.emailVerifiedAt || !user.isActive) {
      return reply.status(403).send({ success: false, error: { code: "EMAIL_NOT_VERIFIED", message: "\u8BF7\u5148\u6253\u5F00\u90AE\u7BB1\u91CC\u7684\u6FC0\u6D3B\u94FE\u63A5\uFF0C\u518D\u767B\u5F55" } });
    }
    if (!user.passwordHash) {
      return reply.status(401).send({ success: false, error: { code: "NO_PASSWORD", message: "\u8BE5\u8D26\u53F7\u672A\u8BBE\u7F6E\u5BC6\u7801\uFF0C\u8BF7\u4F7F\u7528\u7B2C\u4E09\u65B9\u767B\u5F55" } });
    }
    const valid = await bcrypt2.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ success: false, error: { code: "INVALID_CREDENTIALS", message: "\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF" } });
    }
    const jwtToken = app.jwt.sign({ userId: user.id.toString(), role: user.role });
    return { success: true, data: { user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role }, token: jwtToken } };
  });
  app.put("/password", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
    const authToken = auth.slice(7);
    let payload;
    try {
      payload = app.jwt.verify(authToken);
    } catch {
      return reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    }
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: BigInt(payload.userId) } });
    if (!user || !user.isActive) return reply.status(401).send({ success: false, error: { code: "USER_NOT_FOUND" } });
    if (!user.passwordHash) return reply.status(400).send({ success: false, error: { code: "NO_PASSWORD", message: "\u8BE5\u8D26\u53F7\u672A\u8BBE\u7F6E\u5BC6\u7801" } });
    const valid = await bcrypt2.compare(currentPassword, user.passwordHash);
    if (!valid) return reply.status(400).send({ success: false, error: { code: "WRONG_PASSWORD", message: "\u5F53\u524D\u5BC6\u7801\u9519\u8BEF" } });
    const newHash = await bcrypt2.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
    return { success: true, data: { message: "\u5BC6\u7801\u4FEE\u6539\u6210\u529F" } };
  });
  app.get("/me", async (req, reply) => {
    try {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
      const authToken = auth.slice(7);
      const payload = app.jwt.verify(authToken);
      const user = await prisma.user.findUnique({
        where: { id: BigInt(payload.userId) },
        select: { id: true, email: true, displayName: true, avatarUrl: true, role: true, isActive: true, emailVerifiedAt: true, createdAt: true }
      });
      if (!user || !user.isActive) return reply.status(401).send({ success: false, error: { code: "USER_NOT_FOUND" } });
      return { success: true, data: user };
    } catch {
      return reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    }
  });
}

// src/routes/community.ts
import { z as z18 } from "zod";
var commentSchema = z18.object({
  body: z18.string().trim().min(1).max(2e3)
});
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt
  };
}
async function requireUser(app, req, reply) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ") || auth.length <= 7) {
    reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED", message: "\u8BF7\u5148\u767B\u5F55" } });
    return null;
  }
  try {
    const payload = app.jwt.verify(auth.slice(7));
    const user = await app.prisma.user.findUnique({
      where: { id: BigInt(payload.userId) },
      select: { id: true, email: true, displayName: true, avatarUrl: true, role: true, isActive: true, createdAt: true }
    });
    if (!user?.isActive) {
      reply.status(401).send({ success: false, error: { code: "USER_NOT_FOUND", message: "\u8D26\u53F7\u4E0D\u53EF\u7528" } });
      return null;
    }
    return user;
  } catch {
    reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN", message: "\u767B\u5F55\u5DF2\u8FC7\u671F" } });
    return null;
  }
}
async function findFigure(app, slug, reply) {
  const figure = await app.prisma.figure.findFirst({
    where: { slug, isDeleted: false },
    select: { id: true, slug: true, name: true }
  });
  if (!figure) {
    reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND", message: "Figure not found" } });
    return null;
  }
  return figure;
}
function isSafeDisplayImage2(image) {
  if (!image) return false;
  const w = Number(image.width) || 0;
  const h = Number(image.height) || 0;
  const source = String(image.source || image.url || "");
  const metaData = image.data || {};
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
function compactFigure(figure) {
  const safeImages = (figure.images || []).filter((img) => isSafeDisplayImage2(img));
  const firstImage = safeImages[0] || null;
  return {
    id: figure.id,
    slug: figure.slug,
    name: figure.name,
    nameEn: figure.nameEn,
    nameJp: figure.nameJp,
    releaseDate: figure.releaseDate,
    image: firstImage ? { ...firstImage, url: `/api/v1/figures/images/${firstImage.id}` } : null
  };
}
function sanitizeUserText(s) {
  var cleaned = String(s || "");
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return cleaned;
}
async function communityRoutes(app) {
  const prisma = app.prisma;
  app.get("/me/space", async (req, reply) => {
    const user = await requireUser(app, req, reply);
    if (!user) return;
    const [favorites, likes, comments] = await Promise.all([
      prisma.favorite.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 60,
        include: {
          figure: {
            include: {
              images: {
                orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
                take: 1,
                select: { id: true, alt: true, width: true, height: true, source: true, size: true, data: true }
              }
            }
          }
        }
      }),
      prisma.figureLike.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 60,
        include: {
          figure: {
            include: {
              images: {
                orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
                take: 1,
                select: { id: true, alt: true, width: true, height: true, source: true, size: true, data: true }
              }
            }
          }
        }
      }),
      prisma.figureComment.findMany({
        where: { userId: user.id, isDeleted: false },
        orderBy: { createdAt: "desc" },
        take: 60,
        include: { figure: { select: { id: true, slug: true, name: true, nameEn: true, nameJp: true } } }
      })
    ]);
    return {
      success: true,
      data: {
        user: publicUser(user),
        favorites: favorites.map((item) => ({ id: item.id, createdAt: item.createdAt, figure: compactFigure(item.figure) })),
        likes: likes.map((item) => ({ id: item.id, createdAt: item.createdAt, figure: compactFigure(item.figure) })),
        comments: comments.map((item) => ({
          id: item.id,
          body: item.body,
          createdAt: item.createdAt,
          figure: item.figure
        }))
      }
    };
  });
  app.get("/figures/:slug/social", async (req, reply) => {
    const { slug } = req.params;
    const figure = await prisma.figure.findFirst({
      where: { slug, isDeleted: false },
      select: { id: true }
    });
    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });
    let userId = null;
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ") && auth.length > 7) {
      try {
        const payload = app.jwt.verify(auth.slice(7));
        userId = BigInt(payload.userId);
      } catch {
        userId = null;
      }
    }
    const [favoriteCount, likeCount, commentCount, favorite, like] = await Promise.all([
      prisma.favorite.count({ where: { figureId: figure.id } }),
      prisma.figureLike.count({ where: { figureId: figure.id } }),
      prisma.figureComment.count({ where: { figureId: figure.id, isDeleted: false } }),
      userId ? prisma.favorite.findUnique({ where: { userId_figureId: { userId, figureId: figure.id } } }) : null,
      userId ? prisma.figureLike.findUnique({ where: { userId_figureId: { userId, figureId: figure.id } } }) : null
    ]);
    return {
      success: true,
      data: {
        counts: { favorites: favoriteCount, likes: likeCount, comments: commentCount },
        viewer: { favorited: Boolean(favorite), liked: Boolean(like) }
      }
    };
  });
  app.post("/figures/:slug/favorite", async (req, reply) => {
    const user = await requireUser(app, req, reply);
    if (!user) return;
    const figure = await findFigure(app, req.params.slug, reply);
    if (!figure) return;
    const favorite = await prisma.favorite.upsert({
      where: { userId_figureId: { userId: user.id, figureId: figure.id } },
      create: { userId: user.id, figureId: figure.id },
      update: {}
    });
    return { success: true, data: { favorited: true, favoriteId: favorite.id } };
  });
  app.delete("/figures/:slug/favorite", async (req, reply) => {
    const user = await requireUser(app, req, reply);
    if (!user) return;
    const figure = await findFigure(app, req.params.slug, reply);
    if (!figure) return;
    await prisma.favorite.deleteMany({ where: { userId: user.id, figureId: figure.id } });
    return { success: true, data: { favorited: false } };
  });
  app.post("/figures/:slug/like", async (req, reply) => {
    const user = await requireUser(app, req, reply);
    if (!user) return;
    const figure = await findFigure(app, req.params.slug, reply);
    if (!figure) return;
    const like = await prisma.figureLike.upsert({
      where: { userId_figureId: { userId: user.id, figureId: figure.id } },
      create: { userId: user.id, figureId: figure.id },
      update: {}
    });
    return { success: true, data: { liked: true, likeId: like.id } };
  });
  app.delete("/figures/:slug/like", async (req, reply) => {
    const user = await requireUser(app, req, reply);
    if (!user) return;
    const figure = await findFigure(app, req.params.slug, reply);
    if (!figure) return;
    await prisma.figureLike.deleteMany({ where: { userId: user.id, figureId: figure.id } });
    return { success: true, data: { liked: false } };
  });
  app.get("/figures/:slug/comments", async (req, reply) => {
    const { slug } = req.params;
    const figure = await prisma.figure.findFirst({ where: { slug, isDeleted: false }, select: { id: true } });
    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND" } });
    const comments = await prisma.figureComment.findMany({
      where: { figureId: figure.id, isDeleted: false },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: { select: { id: true, displayName: true, avatarUrl: true } }
      }
    });
    return { success: true, data: comments };
  });
  app.post("/figures/:slug/comments", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await requireUser(app, req, reply);
    if (!user) return;
    const figure = await findFigure(app, req.params.slug, reply);
    if (!figure) return;
    const { body } = commentSchema.parse(req.body);
    const sanitizedBody = sanitizeUserText(body);
    const comment = await prisma.figureComment.create({
      data: { userId: user.id, figureId: figure.id, body: sanitizedBody },
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: { select: { id: true, displayName: true, avatarUrl: true } }
      }
    });
    return reply.status(201).send({ success: true, data: comment });
  });
}

// src/app.ts
Object.defineProperty(BigInt.prototype, "toJSON", {
  value: function() {
    return this.toString();
  },
  writable: true,
  configurable: true
});
async function buildApp(options) {
  const app = Fastify({
    logger: true,
    trustProxy: true,
    bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 20 * 1024 * 1024)
  });
  const jwtSecret = process.env.JWT_SECRET || "dev-secret-change-in-production";
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && (!process.env.JWT_SECRET || jwtSecret === "dev-secret-change-in-production" || jwtSecret.length < 32)) {
    throw new Error("JWT_SECRET must be set to a strong secret in production");
  }
  const corsOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean) : false;
  await app.register(cors, {
    origin: corsOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        imgSrc: ["'self'", "data:", "https:"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"]
      }
    },
    frameguard: false,
    crossOriginResourcePolicy: { policy: "same-origin" }
  });
  await app.register(jwt, {
    secret: jwtSecret,
    sign: { algorithm: "HS256", expiresIn: process.env.JWT_EXPIRES_IN || "2h" }
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip
  });
  if (!options?.skipLifecycle) {
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
  } else {
    const prisma = new PrismaClient2();
    const redis = new Redis2(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true
    });
    app.decorate("prisma", prisma);
    app.decorate("redis", redis);
    app.addHook("onClose", async () => {
      await prisma.$disconnect();
      try {
        await redis.quit();
      } catch {
      }
    });
  }
  function isFigureInteractionPath(path5) {
    return /^\/api\/v1\/figures\/[^/]+\/(social|favorite|like|comments)(?:\?|\/|$)/.test(path5);
  }
  app.addHook("onRequest", async (req, reply) => {
    const p = req.url;
    const isAdminPath = p.startsWith("/api/v1/admin");
    const isAuthPath = p.startsWith("/api/v1/auth");
    const isWriteMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    const isFigureWritePath = p.startsWith("/api/v1/figures") && isWriteMethod && !isFigureInteractionPath(p);
    const isEntityWritePath = (p.startsWith("/api/v1/manufacturers") || p.startsWith("/api/v1/series") || p.startsWith("/api/v1/sculptors") || p.startsWith("/api/v1/categories") || p.startsWith("/api/v1/characters")) && isWriteMethod;
    if (isAdminPath || isAuthPath) {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    }
    if (isAdminPath || isFigureWritePath || isEntityWritePath) {
      try {
        const auth = req.headers.authorization;
        if (!auth?.startsWith("Bearer ") || auth.length <= 7) throw new Error();
        const payload = app.jwt.verify(auth.slice(7));
        const user = await app.prisma.user.findUnique({
          where: { id: BigInt(payload.userId) },
          select: { id: true, role: true, isActive: true }
        });
        if (!user?.isActive || user.role !== "admin") throw new Error();
        req.user = { userId: user.id.toString(), role: user.role };
      } catch {
        return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
      }
    }
  });
  app.get("/health", async () => ({ status: "ok", timestamp: (/* @__PURE__ */ new Date()).toISOString() }));
  app.register(imageRoutes, { prefix: "/api/v1/figures/images" });
  app.register(figureRoutes, { prefix: "/api/v1/figures" });
  app.register(searchRoutes, { prefix: "/api/v1/search" });
  app.register(categoryRoutes, { prefix: "/api/v1/categories" });
  app.register(seriesRoutes, { prefix: "/api/v1/series" });
  app.register(manufacturerRoutes, { prefix: "/api/v1/manufacturers" });
  app.register(sculptorRoutes, { prefix: "/api/v1/sculptors" });
  app.register(characterRoutes, { prefix: "/api/v1/characters" });
  app.get("/api/v1/review/cached-image/:reviewId/:fileName", async (req, reply) => {
    const { reviewId, fileName } = req.params;
    try {
      if (!/^[a-zA-Z0-9_-]+$/.test(reviewId) || !/^[a-f0-9]{64}\.[a-z]+$/i.test(fileName)) {
        return reply.status(404).send({ success: false, error: { code: "NOT_FOUND" } });
      }
      const signingSecret = process.env.REVIEW_CACHE_SIGNING_SECRET;
      if (!signingSecret) {
        return reply.status(500).send({ success: false, error: { code: "SIGNING_NOT_CONFIGURED", message: "REVIEW_CACHE_SIGNING_SECRET is not set" } });
      }
      const qExp = req.query.exp;
      const qSig = req.query.sig;
      if (!qExp || !qSig) {
        return reply.status(403).send({ success: false, error: { code: "ACCESS_DENIED" } });
      }
      const expInt = parseInt(qExp, 10);
      if (isNaN(expInt) || Date.now() > expInt) {
        return reply.status(403).send({ success: false, error: { code: "ACCESS_DENIED" } });
      }
      const maxTtl = 864e5;
      if (expInt > Date.now() + maxTtl) {
        return reply.status(403).send({ success: false, error: { code: "ACCESS_DENIED" } });
      }
      const signPayload = `${reviewId}/${fileName}:${qExp}`;
      const expectedSig = crypto7.createHmac("sha256", signingSecret).update(signPayload).digest("hex");
      if (qSig.length !== expectedSig.length) {
        return reply.status(403).send({ success: false, error: { code: "ACCESS_DENIED" } });
      }
      if (!crypto7.timingSafeEqual(Buffer.from(qSig), Buffer.from(expectedSig))) {
        return reply.status(403).send({ success: false, error: { code: "ACCESS_DENIED" } });
      }
      const REVIEW_CACHE_DIR = process.env.REVIEW_CACHE_DIR || "/app/assets/review-cache";
      const filePath = path4.join(REVIEW_CACHE_DIR, reviewId, fileName);
      if (!fs4.existsSync(filePath)) {
        return reply.status(404).send({ success: false, error: { code: "NOT_FOUND" } });
      }
      const fileBuf = fs4.readFileSync(filePath);
      let ct = "image/jpeg";
      try {
        const meta = await sharp4(fileBuf).metadata();
        if (meta.format === "png") ct = "image/png";
        else if (meta.format === "webp") ct = "image/webp";
        else if (meta.format === "jpeg") ct = "image/jpeg";
      } catch {
      }
      reply.header("Content-Type", ct);
      reply.header("Cache-Control", "private, max-age=86400");
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(fileBuf);
    } catch {
      return reply.status(404).send({ success: false, error: { code: "NOT_FOUND" } });
    }
  });
  app.register(adminRoutes, { prefix: "/api/v1/admin" });
  app.register(authRoutes, { prefix: "/api/v1/auth" });
  app.register(communityRoutes, { prefix: "/api/v1" });
  app.setErrorHandler((error, req, reply) => {
    if (error?.name === "ZodError" || Array.isArray(error?.issues)) {
      return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", details: error.issues || error.errors } });
    }
    if (error.validation) return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", details: error.validation } });
    if (error.statusCode === 429) return reply.status(429).send({ success: false, error: { code: "RATE_LIMITED" } });
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        success: false,
        error: {
          code: error.code || "BAD_REQUEST",
          message: error.message
        }
      });
    }
    app.log.error(error);
    reply.status(500).send({ success: false, error: { code: "INTERNAL_ERROR" } });
  });
  return app;
}

// src/index.ts
async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: 3e3, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
