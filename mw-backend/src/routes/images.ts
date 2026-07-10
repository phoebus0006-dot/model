import { FastifyInstance } from "fastify";
import { z } from "zod";
import http from "http";
import https from "https";
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import sharp from "sharp";
import dns from "dns";
import os from "os";

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const DOWNLOAD_TIMEOUT = 15_000; // 15 seconds
const ASSETS_PATH = process.env.ASSETS_PATH || "/app/assets";
const MAX_REDIRECTS = 5;

const IMAGE_SIZES = {
  raw: { width: null, quality: 100 },
  detail: { width: 1200, quality: 85 },
  thumb: { width: 300, quality: 80 },
} as const;

type ImageSize = keyof typeof IMAGE_SIZES;

interface DownloadResult {
  buffer: Buffer;
  contentType: string | undefined;
}

// ===== 安全：URL校验，防止SSRF =====
const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1",
  "169.254.169.254",
  "metadata.google.internal",
]);

function isPrivateIp(ip: string): boolean {
  // IPv4
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p))) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 127) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  // IPv6
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("FE80:") || ip.startsWith("fe80:")) return true;
  if (ip.startsWith("ff") || ip.startsWith("FF")) return true;
  // Check if it's an IPv6 mapped IPv4 (e.g. ::ffff:10.0.0.1)
  const v4match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4match) return isPrivateIp(v4match[1]);
  return false;
}

async function resolveAndValidateHost(hostname: string): Promise<{ ok: boolean; reason?: string; address?: string }> {
  try {
    const addresses = await dns.promises.resolve4(hostname);
    if (addresses.length === 0) {
      // Try AAAA
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
  } catch (e: any) {
    return { ok: false, reason: `DNS resolution failed: ${e.message || e}` };
  }
}

export async function validateImageUrl(imageUrl: string): Promise<{ ok: boolean; reason?: string; resolvedAddress?: string }> {
  try {
    const u = new URL(imageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, reason: "Only http(s) URLs are allowed" };
    }
    const host = u.hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(host)) return { ok: false, reason: "Blocked host" };
    // DNS resolve and validate IP
    const resolved = await resolveAndValidateHost(host);
    if (!resolved.ok) return { ok: false, reason: resolved.reason || "Host validation failed" };
    return { ok: true, resolvedAddress: resolved.address };
  } catch (e: any) {
    return { ok: false, reason: "Invalid URL: " + (e?.message || "") };
  }
}

// ===== 安全：janCode/sha256 格式校验，防止路径遍历 =====
function validateJanCode(janCode: string): boolean {
  if (!janCode || typeof janCode !== "string") return false;
  if (/[\\/]/.test(janCode)) return false;
  if (janCode.includes("..")) return false;
  if (janCode.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(janCode) || janCode === "no-jancode";
}

function validateSha256(sha256: string): boolean {
  if (!sha256 || typeof sha256 !== "string") return false;
  return /^[a-f0-9]{64}$/i.test(sha256);
}

function safeBigInt(value: string): bigint | null {
  try {
    if (!/^-?\d+$/.test(value)) return null;
    return BigInt(value);
  } catch {
    return null;
  }
}


export async function downloadImage(imageUrl: string, redirectDepth = 0): Promise<DownloadResult> {
  if (redirectDepth > MAX_REDIRECTS) {
    return Promise.reject(new Error("Too many redirects"));
  }
  const urlCheck = await validateImageUrl(imageUrl);
  if (!urlCheck.ok) {
    return Promise.reject(new Error("URL validation failed: " + (urlCheck.reason || "blocked")));
  }
  return new Promise<DownloadResult>((resolve, reject) => {
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
          Referer: new URL(imageUrl).origin + "/",
        },
        timeout: DOWNLOAD_TIMEOUT,
        servername: urlObj.hostname,
      },
      (res) => {
        // Follow redirects (re-validate each hop)
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
        const chunks: Buffer[] = [];
        let size = 0;

        res.on("data", (chunk: Buffer) => {
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

function computeSha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function getImageDir(janCode: string): string {
  return path.join(ASSETS_PATH, "figures", janCode);
}

function getImageFilePath(janCode: string, sha256: string, size: ImageSize): string {
  if (!validateJanCode(janCode)) throw new Error("Invalid janCode");
  if (!validateSha256(sha256)) throw new Error("Invalid sha256");
  return path.join(getImageDir(janCode), `${sha256}_${size}.webp`);
}

export interface ImageRecordData {
  janCode: string;
  sha256: string;
  size: string;
  format: string;
  width: number | null;
  height: number | null;
  fileSize: number;
  source: string;
  alt?: string;
  sortOrder: number;
  isNsfw?: boolean;
}

export async function upsertFigureImageRecord(app: FastifyInstance, data: any) {
  const source = data.source ? String(data.source) : null;
  const sha256 = data.sha256 ? String(data.sha256) : null;
  const size = String(data.size || "raw");
  const whereBase = { figureId: data.figureId, size };

  let existing = source
    ? await app.prisma.figureImage.findFirst({
        where: { ...whereBase, source },
        orderBy: { id: "asc" },
      })
    : null;

  if (!existing && sha256) {
    existing = await app.prisma.figureImage.findFirst({
      where: { ...whereBase, sha256 },
      orderBy: { id: "asc" },
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
    data: data.data ?? null,
  };

  const image = existing
    ? await app.prisma.figureImage.update({ where: { id: existing.id }, data: payload })
    : await app.prisma.figureImage.create({ data: payload });

  return { image, created: !existing };
}

/**
 * Downloads an image from a URL, computes its SHA-256 hash, converts it to WebP
 * at 3 sizes (raw, detail, thumb), and saves the files to disk.
 *
 * Returns an array of 3 image record data objects (one per size) ready to be
 * inserted into the database by the caller (e.g. figures.ts).
 */
export async function processAndStoreImage(
  imageUrl: string,
  janCode: string,
  options?: { alt?: string; sortOrder?: number; isNsfw?: boolean }
): Promise<ImageRecordData[]> {
  const { alt, sortOrder = 0, isNsfw = false } = options || {};

  // 1. Download image
  const { buffer } = await downloadImage(imageUrl);

  // 2. Compute SHA-256 of original image data
  const sha256 = computeSha256(buffer);

  // 3. Ensure output directory exists
  const dir = getImageDir(janCode);
  fs.mkdirSync(dir, { recursive: true });

  // 4. Load image into sharp to get metadata
  const metadata = await sharp(buffer).metadata();
  const originalWidth = metadata.width || 0;

  const results: ImageRecordData[] = [];

  // 5. Generate each size
  for (const [sizeName, config] of Object.entries(IMAGE_SIZES)) {
    const filePath = getImageFilePath(janCode, sha256, sizeName as ImageSize);

    // Skip if file already exists (dedup by sha256 + size)
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
        isNsfw,
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
      isNsfw,
    });
  }

  return results;
}

const uploadSchema = z.object({
  url: z.string().url(),
  figureId: z.number().int().optional(),
  janCode: z.string().optional(),
  alt: z.string().optional(),
  sortOrder: z.number().int().optional(),
});

const proxyQuerySchema = z.object({
  url: z.string().url(),
});

// Schema for registering pre-processed image metadata (no download needed)
const registerSchema = z.object({
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
  data: z.any().optional(),
});

const processedUploadSchema = registerSchema.extend({
  contentBase64: z.string().min(1),
});

async function resolveStorageJanCode(app: FastifyInstance, figureId: number, janCode?: string | null): Promise<string> {
  if (janCode) return janCode;
  const figure = await app.prisma.figure.findUnique({
    where: { id: BigInt(figureId) },
    select: { janCode: true },
  });
  return figure?.janCode || "no-jancode";
}

async function invalidateFigureImageCaches(app: FastifyInstance) {
  const detailKeys = await app.redis.keys("figures:detail:*");
  if (detailKeys.length > 0) await app.redis.del(...detailKeys);
  const listKeys = await app.redis.keys("figures:list:*");
  if (listKeys.length > 0) await app.redis.del(...listKeys);
}

export async function imageRoutes(app: FastifyInstance) {
  // Register pre-processed image metadata (for local scraper workflow)
  // The scraper processes images locally, then registers the metadata here
  // Image files must be uploaded separately (scp + docker cp)
  app.post<{ Body: z.infer<typeof registerSchema> }>("/register", async (req, reply) => {
    const data = registerSchema.parse(req.body);

    try {
      // Resolve janCode from figureId if not provided
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
        isNsfw: data.isNsfw || false,
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
          updated: !created,
        },
      });
    } catch (err: any) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "IMAGE_REGISTER_FAILED",
          message: err.message || "Failed to register image metadata",
        },
      });
    }
  });

  // Upload an already processed WebP image from a trusted worker such as the
  // Feiniu NAS crawler. This avoids server-side hotlink downloads from sources
  // that block datacenter IPs.
  app.post<{ Body: z.infer<typeof processedUploadSchema> }>("/upload-processed", async (req, reply) => {
    const data = processedUploadSchema.parse(req.body);

    try {
      const janCode = await resolveStorageJanCode(app, data.figureId, data.janCode);
      const buffer = Buffer.from(data.contentBase64, "base64");
      if (!buffer.length) {
        return reply.status(422).send({
          success: false,
          error: { code: "EMPTY_IMAGE", message: "contentBase64 decoded to an empty file" },
        });
      }

      const filePath = getImageFilePath(janCode, data.sha256, data.size as ImageSize);
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
        data: data.data || null,
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
          updated: !created,
        },
      });
    } catch (err: any) {
      req.log.error({ err }, "Processed image upload failed");
      return reply.status(422).send({
        success: false,
        error: {
          code: "PROCESSED_IMAGE_UPLOAD_FAILED",
          message: err.message || "Failed to upload processed image",
        },
      });
    }
  });

  // Upload external image: download, convert to WebP, save to filesystem
  app.post<{ Body: z.infer<typeof uploadSchema> }>("/upload", async (req, reply) => {
    const { url, figureId, janCode, alt, sortOrder } = uploadSchema.parse(req.body);

    if (!janCode && !figureId) {
      return reply.status(400).send({
        success: false,
        error: {
          code: "MISSING_IDENTIFIER",
          message: "Either janCode or figureId must be provided",
        },
      });
    }

    try {
      // Resolve janCode from figureId if not provided directly
      let resolvedJanCode = janCode || "";
      if (!resolvedJanCode && figureId) {
        const figure = await app.prisma.figure.findUnique({
          where: { id: BigInt(figureId) },
          select: { janCode: true },
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
            message: "Could not resolve janCode for image storage",
          },
        });
      }

      const imageRecords = await processAndStoreImage(url, resolvedJanCode, {
        alt,
        sortOrder,
      });

      // If figureId provided, create DB records
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
            isNsfw: rec.isNsfw || false,
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
              fileSize: r.fileSize,
            })),
            originalUrl: url,
            figureId,
          },
        });
      }

      // No figureId — just process and return info
      return reply.status(200).send({
        success: true,
        data: {
          janCode: resolvedJanCode,
          sha256: imageRecords[0].sha256,
          sizes: imageRecords.map((r) => ({
            size: r.size,
            width: r.width,
            height: r.height,
            fileSize: r.fileSize,
          })),
          originalUrl: url,
          message: "Image processed and saved to disk. Use with figure creation to store in DB.",
        },
      });
    } catch (err: any) {
      req.log.error({ err, url }, "Image upload failed");
      return reply.status(422).send({
        success: false,
        error: {
          code: "IMAGE_PROCESSING_FAILED",
          message: err.message || "Failed to process image",
        },
      });
    }
  });

  // Proxy: download and return image as WebP (for immediate display)
  app.get<{ Querystring: z.infer<typeof proxyQuerySchema> }>("/proxy", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (req: any, reply: any) => {
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

      // Convert to WebP for proxy responses too
      const webpBuffer = await sharp(result.buffer).webp({ quality: 85 }).toBuffer();

      reply.header("Content-Type", "image/webp");
      reply.header("Content-Length", webpBuffer.length);
      reply.header("Cache-Control", "public, max-age=86400");
      reply.header("Access-Control-Allow-Origin", "*");

      return reply.send(webpBuffer);
    } catch (err: any) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "IMAGE_DOWNLOAD_FAILED",
          message: err.message || "Failed to download image",
        },
      });
    }
  });

  // Serve image from filesystem by DB record ID
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const id = safeBigInt(req.params.id);
    if (id === null) {
      return reply.status(400).send({ success: false, error: { code: "INVALID_ID", message: "Invalid image ID" } });
    }

    const image = await app.prisma.figureImage.findUnique({
      where: { id },
      select: { janCode: true, sha256: true, size: true, format: true, fileSize: true, source: true, url: true },
    });

    if (!image) {
      return reply.status(404).send({ success: false, error: { code: "IMAGE_NOT_FOUND" } });
    }

    // New-style: image stored on filesystem with sha256
    if (image.sha256 && image.janCode) {
      const filePath = getImageFilePath(image.janCode, image.sha256, image.size as ImageSize);

      if (fs.existsSync(filePath)) {
        reply.header("Content-Type", "image/webp");
        reply.header("Content-Length", image.fileSize || undefined);
        reply.header("Cache-Control", "public, max-age=2592000, immutable");
        reply.header("Access-Control-Allow-Origin", "*");
        const stream = fs.createReadStream(filePath);
        return reply.send(stream);
      }
    }

    // Legacy fallback: image has url or source URL but no file on disk
    const legacyUrl = image.url || (image.source && image.source.startsWith("http") ? image.source : null);
    if (legacyUrl) {
      // Try direct download proxy
      try {
        const result = await downloadImage(legacyUrl);
        reply.header("Content-Type", result.contentType || "image/jpeg");
        reply.header("Cache-Control", "public, max-age=86400");
        reply.header("Access-Control-Allow-Origin", "*");
        return reply.send(result.buffer);
      } catch {
        // Validate URL before redirect (open redirect / SSRF prevention)
        const urlCheck = await validateImageUrl(legacyUrl);
        if (!urlCheck.ok) {
          return reply.status(422).send({ success: false, error: { code: "URL_BLOCKED", message: urlCheck.reason || "URL not allowed for redirect" } });
        }
        // Download failed (e.g. Cloudflare challenge). Redirect browser to source URL.
        // The browser can handle Cloudflare JS challenges; server-side cannot.
        reply.code(302);
        reply.header("location", legacyUrl);
        return reply.send();
      }
    }

    return reply.status(404).send({ success: false, error: { code: "IMAGE_NOT_FOUND" } });
  });
}
