import { FastifyInstance } from "fastify";
import { z } from "zod";

const aigcSchema = z.object({
  figureId: z.number().int().positive(),
  locale: z.enum(["ja", "en", "zh"]).default("en"),
  promptVersion: z.string().optional(),
});

export async function adminAigcRoutes(app: FastifyInstance) {
  app.post("/aigc/generate", async (req: any, reply: any) => {
    const data = aigcSchema.parse(req.body);
    const figure = await app.prisma.figure.findUnique({ where: { id: data.figureId } });
    if (!figure) return reply.status(404).send({ success: false, error: { code: "FIGURE_NOT_FOUND", message: "Figure not found" } });
    await app.redis.lpush("aigc:queue", JSON.stringify({ figureId: data.figureId, figureSlug: figure.slug, locale: data.locale, promptVersion: data.promptVersion || "v1", createdAt: new Date().toISOString() }));
    return { success: true, data: { figureId: data.figureId, status: "queued", locale: data.locale } };
  });

  app.get("/aigc/status/:figureId", async (req: any) => {
    const { figureId } = req.params as { figureId: string };
    const id = parseInt(figureId, 10);
    if (isNaN(id)) return { success: true, data: { status: "invalid_id" } };
    const result = await app.redis.get(`aigc:result:${id}`);
    if (result) return { success: true, data: { status: "completed", result: JSON.parse(result) } };
    const queue = await app.redis.lrange("aigc:queue", 0, -1);
    const inQueue = queue.some((item: string) => { try { return JSON.parse(item).figureId === id; } catch { return false; } });
    return { success: true, data: { status: inQueue ? "queued" : "not_found" } };
  });
}
