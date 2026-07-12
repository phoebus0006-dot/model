import type { PrismaClient } from "@prisma/client";
import https from "https";
import http from "http";
import fs from "fs";
import { validateImageUrl } from "./image-security.js";
import { processAndStoreImageFiles, computeSha256, getImageFilePath, DOWNLOAD_TIMEOUT, MAX_RESPONSE_SIZE, MAX_REDIRECTS, type ImageRecordData, type ImageSize } from "./image-storage.js";
import { upsertFigureImageRecord, type UpsertFigureImageInput } from "./image-repository.js";

interface DownloadResult { buffer: Buffer; contentType: string; }

async function downloadImage(imageUrl: string, redirectDepth = 0): Promise<DownloadResult> {
  if (redirectDepth > MAX_REDIRECTS) return Promise.reject(new Error("Too many redirects"));
  const { ok, resolvedAddress } = await validateImageUrl(imageUrl);
  if (!ok) return Promise.reject(new Error("URL validation failed"));
  return new Promise((resolve, reject) => {
    const u = new URL(imageUrl);
    const isHttps = u.protocol === "https:";
    const port = parseInt(u.port) || (isHttps ? 443 : 80);
    const path = u.pathname + u.search;
    const hostname = u.hostname;

    const opts: http.RequestOptions = {
      host: resolvedAddress,
      port,
      path,
      method: "GET",
      timeout: DOWNLOAD_TIMEOUT,
      headers: {
        "User-Agent": "ModelWiki/1.0",
        "Host": hostname,
      },
    };

    const client = isHttps ? https : http;
    if (isHttps) {
      (opts as any).servername = hostname;
    }

    const req = client.request(opts, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        const nextUrl = new URL(res.headers.location, imageUrl).href;
        validateImageUrl(nextUrl).then(nextCheck => {
          if (!nextCheck.ok) return reject(new Error("Redirect target blocked"));
          return downloadImage(nextUrl, redirectDepth + 1).then(resolve).catch(reject);
        }).catch(reject);
        return;
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const ct = res.headers["content-type"] || "";
      if (ct && !ct.startsWith("image/")) return reject(new Error("Not an image"));
      const chunks: Buffer[] = [];
      let totalSize = 0;
      res.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_RESPONSE_SIZE) { req.destroy(); reject(new Error("Response too large")); }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: ct }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Download timeout")); });
  });
}

function rollbackStoredFiles(janCode: string, records: ImageRecordData[]): void {
  const sizes: ImageSize[] = ["raw", "detail", "thumb"];
  for (const rec of records) {
    for (const size of sizes) {
      try {
        const fp = getImageFilePath(janCode, rec.sha256, size);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch {}
    }
  }
}

export async function processAndStoreImage(
  imageUrl: string, janCode: string, prisma: PrismaClient,
  options?: { alt?: string; sortOrder?: number; isNsfw?: boolean; figureId?: bigint }
): Promise<ImageRecordData[]> {
  const { alt, sortOrder = 0, isNsfw = false, figureId } = options || {};
  const { buffer } = await downloadImage(imageUrl);
  const sha256 = computeSha256(buffer);
  const records = await processAndStoreImageFiles(buffer, janCode, imageUrl, { alt, sortOrder, isNsfw });

  if (figureId) {
    try {
      for (const rec of records) {
        await upsertFigureImageRecord(prisma, {
          figureId, janCode: rec.janCode, sha256: rec.sha256, size: rec.size,
          format: rec.format, width: rec.width, height: rec.height, fileSize: rec.fileSize,
          alt: rec.alt || null, sortOrder: rec.sortOrder, source: rec.source, isNsfw: rec.isNsfw,
        });
      }
    } catch (dbErr) {
      rollbackStoredFiles(janCode, records);
      throw dbErr;
    }
  }
  return records;
}

export { validateImageUrl, downloadImage, upsertFigureImageRecord };
export type { ImageRecordData };
