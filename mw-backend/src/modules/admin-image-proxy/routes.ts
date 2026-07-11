import { FastifyInstance } from "fastify";
import { z } from "zod";
import { validateImageUrl, downloadImage } from "../../routes/images.js";

export async function adminImageProxyRoutes(app: FastifyInstance) {
  app.get("/review/image-proxy", { config: { rateLimit: { max: 100, timeWindow: "1 minute" } } }, async (req: any, reply: any) => {
    if (!req.user || !req.user.role) return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED", message: "Admin auth required" } });
    const { url } = z.object({ url: z.string() }).parse(req.query);
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
    } catch (err: any) {
      return reply.status(422).send({ success: false, error: { code: "IMAGE_PROXY_FAILED", message: err.message || "Failed to fetch image" } });
    }
  });
}
