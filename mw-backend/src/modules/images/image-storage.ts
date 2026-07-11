import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";

const ASSETS_PATH = process.env.ASSETS_PATH || "/app/assets";

export type ImageSize = "raw" | "detail" | "thumb";

export const IMAGE_SIZES: Record<ImageSize, { width: number; quality: number }> = {
  raw: { width: 0, quality: 90 },
  detail: { width: 800, quality: 85 },
  thumb: { width: 300, quality: 75 },
};

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_RESPONSE_SIZE = 15 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT = 15_000;
export const MAX_REDIRECTS = 5;

function getImageDir(janCode: string): string {
  return path.join(ASSETS_PATH, "figures", janCode);
}

function getImageFilePath(janCode: string, sha256: string, size: ImageSize): string {
  return path.join(getImageDir(janCode), `${sha256}_${size}.webp`);
}

export function validateJanCode(janCode: string): boolean {
  if (!janCode || typeof janCode !== "string") return false;
  if (/[\\/]/.test(janCode)) return false;
  if (janCode.includes("..")) return false;
  if (janCode.length > 64) return false;
  return /^[A-Za-z0-9_-]+$/.test(janCode) || janCode === "no-jancode";
}

export function validateSha256(sha256: string): boolean {
  if (!sha256 || typeof sha256 !== "string") return false;
  return /^[a-f0-9]{64}$/i.test(sha256);
}

export function safeBigInt(value: string): bigint | null {
  try {
    if (!/^-?\d+$/.test(value)) return null;
    return BigInt(value);
  } catch { return null; }
}

export function computeSha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export interface ImageRecordData {
  janCode: string;
  sha256: string;
  size: string;
  format: string;
  width: number;
  height: number;
  fileSize: number;
  alt?: string;
  sortOrder: number;
  source: string;
  isNsfw: boolean;
}

export async function processAndStoreImageFiles(
  buffer: Buffer, janCode: string, source: string,
  options?: { alt?: string; sortOrder?: number; isNsfw?: boolean }
): Promise<ImageRecordData[]> {
  const { alt, sortOrder = 0, isNsfw = false } = options || {};
  const sha256 = computeSha256(buffer);
  const dir = getImageDir(janCode);
  fs.mkdirSync(dir, { recursive: true });
  const metadata = await sharp(buffer).metadata();
  const originalWidth = metadata.width || 0;
  const results: ImageRecordData[] = [];

  for (const [sizeName, config] of Object.entries(IMAGE_SIZES)) {
    const filePath = getImageFilePath(janCode, sha256, sizeName as ImageSize);
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      results.push({
        janCode, sha256, size: sizeName, format: "webp",
        width: config.width || originalWidth, height: metadata.height || 0,
        fileSize: stat.size, alt, sortOrder, source, isNsfw,
      });
      continue;
    }
    let processed = buffer;
    if (config.width > 0) {
      processed = await sharp(buffer).resize({ width: config.width, withoutEnlargement: true }).webp({ quality: config.quality }).toBuffer();
    } else {
      processed = await sharp(buffer).webp({ quality: config.quality }).toBuffer();
    }
    const tmpPath = filePath + ".tmp." + crypto.randomBytes(8).toString("hex");
    fs.writeFileSync(tmpPath, processed);
    fs.renameSync(tmpPath, filePath);
    results.push({
      janCode, sha256, size: sizeName, format: "webp",
      width: config.width || originalWidth,
      height: metadata.height ? Math.round(metadata.height * (config.width ? config.width / originalWidth : 1)) : 0,
      fileSize: processed.length, alt, sortOrder, source, isNsfw,
    });
  }
  return results;
}

export function getReviewImageFilePath(janCode: string, sha256: string, size: string): string {
  return path.join(ASSETS_PATH, "figures", janCode, `${sha256}_${size}.webp`);
}

export const REVIEW_IMAGE_SIZES = new Set(["raw", "detail", "thumb"]);
