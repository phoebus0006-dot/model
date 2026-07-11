import { FastifyInstance } from "fastify";
import fsp from "fs/promises";
import path from "path";
import sharp from "sharp";
import crypto from "crypto";

export async function adminCacheCandidateRoutes(app: FastifyInstance) {
  const REVIEW_CACHE_DIR = process.env.REVIEW_CACHE_DIR || "/app/assets/review-cache";

  app.post<{ Body: { reviewId: string; hash: string; contentBase64: string; ext?: string } }>(
    "/review/cache-candidate",
    { preHandler: [async (req: any, reply: any) => {
      if (!req.user || !req.user.role) {
        return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
      }
    }] },
    async (req: any, reply: any) => {
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
        meta = await sharp(buf).metadata();
        if (!meta.format || !["jpeg", "png", "webp"].includes(meta.format)) {
          return reply.status(422).send({ success: false, error: { code: "NOT_IMAGE" } });
        }
        fileExt = meta.format === "jpeg" ? "jpg" : meta.format;
      } catch {
        return reply.status(422).send({ success: false, error: { code: "NOT_IMAGE" } });
      }
      const actualHash = crypto.createHash("sha256").update(buf).digest("hex");
      if (actualHash !== hash.toLowerCase()) {
        return reply.status(422).send({ success: false, error: { code: "HASH_MISMATCH", message: "Content sha256 does not match submitted hash" } });
      }
      const reEncoded = await sharp(buf)
        .rotate()
        .toFormat(meta.format || "jpeg", { quality: 90 })
        .toBuffer();
      const normalizedHash = crypto.createHash("sha256").update(reEncoded).digest("hex");
      const reviewDir = path.join(REVIEW_CACHE_DIR, reviewId);
      const resolved = path.resolve(reviewDir);
      const cacheRoot = path.resolve(REVIEW_CACHE_DIR);
      if (!resolved.startsWith(cacheRoot + path.sep) && resolved !== cacheRoot) {
        return reply.status(422).send({ success: false, error: { code: "PATH_TRAVERSAL" } });
      }
      await fsp.mkdir(reviewDir, { recursive: true });
      const fileName = normalizedHash + "." + fileExt;
      const filePath = path.join(reviewDir, fileName);
      const tmpPath = filePath + ".tmp." + crypto.randomBytes(8).toString("hex");
      try {
        await fsp.writeFile(tmpPath, reEncoded);
        await fsp.rename(tmpPath, filePath);
      } catch (writeErr: any) {
        try { await fsp.unlink(tmpPath); } catch {}
        return reply.status(500).send({ success: false, error: { code: "FILE_WRITE_FAILED", message: writeErr?.message || "Failed to write cache file" } });
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
