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
import { scanKeys } from "../security/redisGuard.js";

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const DOWNLOAD_TIMEOUT = 15_000; // 15 seconds
function getAssetsPath(): string {
  return process.env.ASSETS_PATH || "/app/assets";
}
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

function getImageDir(janCode: string): string {
  return path.join(getAssetsPath(), "figures", janCode);
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
  width: number;
  height: number;
  fileSize: number;
  alt?: string | null;
  sortOrder?: number;
  source?: string;
  isNsfw?: boolean;
}

function validateJanCode(janCode: string): boolean {
  return /^\d{8,13}$/.test(janCode);
}

function validateSha256(sha256: string): boolean {
  return /^[a-f0-9]{64}$/i.test(sha256);
}

async function isPrivateIp(ip: string): Promise<boolean> {
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;

  if (ip.startsWith("172.")) {
    const parts = ip.split(".");
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) return true;
  }

  if (ip.startsWith("169.254.")) return true;
  if (ip === "0.0.0.0") return true;

  return false;
}

async function validateImageUrl(urlStr: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const parsed = new URL(urlStr);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "Only HTTP/HTTPS URLs allowed" };
    }

    const hostname = parsed.hostname;

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return { ok: false, reason: "Localhost addresses not allowed" };
    }

    try {
      const addresses = await dns.promises.lookup(hostname, { all: true });
      for (const addr of addresses) {
        if (await isPrivateIp(addr.address)) {
          return { ok: false, reason: `Resolved IP ${addr.address} is private/internal` };
        }
      }
    } catch {
      return { ok: false, reason: `DNS resolution failed for ${hostname}` };
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: `Invalid URL: ${err.message}` };
  }
}

function safeBigInt(val: string): bigint | null {
  try {
    return BigInt(val);
  } catch {
    return null;
  }
}

async function downloadImage(urlStr: string, redirectCount = 0): Promise<DownloadResult> {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error("Too many redirects");
  }

  const urlCheck = await validateImageUrl(urlStr);
  if (!urlCheck.ok) {
    throw new Error(`SSRF Blocked: ${urlCheck.reason}`);
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.get(
      urlStr,
      {
        headers: {
          "User-Agent": "ModelWiki-ImageFetcher/1.0",
          Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
        },
        timeout: DOWNLOAD_TIMEOUT,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const redirectUrl = new URL(res.headers.location, urlStr).toString();
          downloadImage(redirectUrl, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode || "unknown"} fetching image`));
          return;
        }

        const contentType = res.headers["content-type"];
        const contentLength = parseInt(res.headers["content-length"] || "0", 10);

        if (contentLength > MAX_IMAGE_SIZE) {
          reject(new Error(`Image size ${contentLength} exceeds limit ${MAX_IMAGE_SIZE}`));
          return;
        }

        const chunks: Buffer[] = [];
        let totalSize = 0;

        res.on("data", (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_IMAGE_SIZE) {
            req.destroy();
            reject(new Error(`Image size exceeded limit ${MAX_IMAGE_SIZE} during download`));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({ buffer, contentType });
        });

        res.on("error", (err) => {
          reject(err);
        });
      }
    );

    req.on("error", (err) => {
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Image download timed out"));
    });
  });
}

async function invalidateImageCaches(app: FastifyInstance, janCode?: string, figureId?: string) {
  if (janCode) {
    await app.redis.del(`images:jan:${janCode}`);
  }
  if (figureId) {
    const figure = await app.prisma.figure.findUnique({
      where: { id: BigInt(figureId) },
      select: { slug: true },
    });
    if (figure?.slug) {
      await app.redis.del(`figures:detail:${figure.slug}`);

      const pattern = `figures:detail:${figure.slug}:*`;
      const keys = await scanKeys(app.redis, pattern);
      if (keys.length > 0) {
        await app.redis.unlink(...keys);
      }
    }
  }

  const listKeys = await scanKeys(app.redis, "figures:list:*");
  if (listKeys.length > 0) {
    await app.redis.unlink(...listKeys);
  }
}

async function processAndStoreImage(
  url: string,
  janCode: string,
  meta?: { alt?: string; sortOrder?: number }
): Promise<ImageRecordData[]> {
  const { buffer, contentType } = await downloadImage(url);

  const targetDir = getImageDir(janCode);

  await fsp.mkdir(targetDir, { recursive: true });

  const rawSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const rawMeta = await sharp(buffer).metadata();
  const rawWidth = rawMeta.width || 0;
  const rawHeight = rawMeta.height || 0;
  const rawFormat = rawMeta.format || "unknown";

  const rawWebpBuffer = await sharp(buffer).webp({ quality: 100 }).toBuffer();
  const rawFilePath = path.join(targetDir, `${rawSha256}_raw.webp`);
  await fsp.writeFile(rawFilePath, rawWebpBuffer);

  const results: ImageRecordData[] = [
    {
      janCode,
      sha256: rawSha256,
      size: "raw",
      format: "webp",
      width: rawWidth,
      height: rawHeight,
      fileSize: rawWebpBuffer.length,
      alt: meta?.alt,
      sortOrder: meta?.sortOrder ?? 0,
      source: url,
    },
  ];

  for (const [sizeName, cfg] of Object.entries(IMAGE_SIZES)) {
    if (sizeName === "raw") continue;

    let pipeline = sharp(buffer);
    if (cfg.width && rawWidth > cfg.width) {
      pipeline = pipeline.resize(cfg.width, null, { withoutEnlargement: true });
    }

    const webpBuf = await pipeline.webp({ quality: cfg.quality }).toBuffer();

    const resizedMeta = await sharp(webpBuf).metadata();
    const resizedWidth = resizedMeta.width || 0;
    const resizedHeight = resizedMeta.height || 0;

    const resizedSha256 = crypto.createHash("sha256").update(webpBuf).digest("hex");
    const resizedPath = path.join(targetDir, `${resizedSha256}_${sizeName}.webp`);

    await fsp.writeFile(resizedPath, webpBuf);

    results.push({
      janCode,
      sha256: resizedSha256,
      size: sizeName,
      format: "webp",
      width: resizedWidth,
      height: resizedHeight,
      fileSize: webpBuf.length,
      alt: meta?.alt,
      sortOrder: meta?.sortOrder ?? 0,
      source: url,
    });
  }

  return results;
}

async function upsertFigureImageRecord(
  app: FastifyInstance,
  data: {
    figureId: bigint;
    janCode: string;
    sha256: string;
    size: string;
    format: string;
    width: number;
    height: number;
    fileSize: number;
    alt?: string | null;
    sortOrder?: number;
    source?: string;
    isNsfw?: boolean;
  }
) {

  const existing = await app.prisma.figureImage.findFirst({
    where: {
      figureId: data.figureId,
      sha256: data.sha256,
      size: data.size,
    },
  });

  if (existing) {
    return { record: existing, created: false };
  }

  const newRecord = await app.prisma.figureImage.create({
    data: {
      figureId: data.figureId,
      janCode: data.janCode,
      sha256: data.sha256,
      size: data.size,
      format: data.format,
      width: data.width,
      height: data.height,
      fileSize: data.fileSize,
      alt: data.alt || null,
      sortOrder: data.sortOrder ?? 0,
      source: data.source || null,
      isNsfw: data.isNsfw ?? false,
    },
  });

  return { record: newRecord, created: true };
}

const processedUploadSchema = z.object({
  figureId: z.coerce.number().optional(),
  janCode: z.string().optional(),
  sha256: z.string().min(64).max(64),
  size: z.enum(["raw", "detail", "thumb"]),
  format: z.string().default("webp"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fileSize: z.number().int().positive(),
  alt: z.string().optional(),
  sortOrder: z.number().int().default(0),
  isNsfw: z.boolean().default(false),
  url: z.string().optional(),
  source: z.string().optional(),
});

const uploadSchema = z.object({
  url: z.string().url(),
  figureId: z.number().optional(),
  janCode: z.string().optional(),
  alt: z.string().optional(),
  sortOrder: z.number().default(0),
});

const proxyQuerySchema = z.object({
  url: z.string().url(),
});

export async function imageRoutes(app: FastifyInstance) {

  app.post("/processed", async (req, reply) => {
    const payload = processedUploadSchema.parse(req.body);

    let janCode = payload.janCode || "";
    if (!janCode && payload.figureId) {
      const figure = await app.prisma.figure.findUnique({
        where: { id: BigInt(payload.figureId) },
        select: { janCode: true },
      });
      if (figure?.janCode) {
        janCode = figure.janCode;
      }
    }

    if (!janCode) {
      return reply.status(400).send({
        success: false,
        error: {
          code: "MISSING_JAN_CODE",
          message: "janCode is required for image storage",
        },
      });
    }

    try {
      const imageDir = getImageDir(janCode);
      const expectedPath = path.join(imageDir, `${payload.sha256}_${payload.size}.webp`);

      let fileExists = false;
      try {
        await fsp.access(expectedPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      if (!fileExists) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "FILE_NOT_FOUND",
            message: `Processed image file not found on disk at ${expectedPath}. Upload file to filesystem first.`,
          },
        });
      }

      let image: any = null;
      let created = false;

      if (payload.figureId) {
        const result = await upsertFigureImageRecord(app, {
          figureId: BigInt(payload.figureId),
          janCode,
          sha256: payload.sha256,
          size: payload.size,
          format: payload.format,
          width: payload.width,
          height: payload.height,
          fileSize: payload.fileSize,
          alt: payload.alt,
          sortOrder: payload.sortOrder,
          source: payload.source,
          isNsfw: payload.isNsfw,
        });
        image = result.record;
        created = result.created;

        await invalidateImageCaches(app, janCode, String(payload.figureId));
      } else {
        image = {
          id: 0,
          janCode,
          sha256: payload.sha256,
          size: payload.size,
        };
      }

      return reply.status(created ? 201 : 200).send({
        success: true,
        data: {
          id: Number(image.id),
          apiUrl: `/api/v1/figures/images/${image.id}`,
          janCode,
          sha256: payload.sha256,
          size: payload.size,
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

    if (image.sha256 && image.janCode) {
      const filePath = getImageFilePath(image.janCode, image.sha256, (image.size || "original") as ImageSize);

      let fileExists = false;
      try {
        await fsp.access(filePath);
        fileExists = true;
      } catch {
        fileExists = false;
      }
      if (fileExists) {
        reply.header("Content-Type", "image/webp");
        reply.header("Content-Length", image.fileSize || undefined);
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
