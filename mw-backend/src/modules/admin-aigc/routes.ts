import { FastifyInstance } from "fastify";
import { z } from "zod";

const aigcGenerateSchema = z.object({
  figureId: z.string().regex(/^\d+$/, "Figure ID must be a decimal string").transform((val) => BigInt(val)),
  locale: z.enum(["ja", "en", "zh"]).default("en"),
  promptVersion: z.string().optional(),
});

const aigcStatusParamsSchema = z.object({
  figureId: z.string().regex(/^\d+$/, "Figure ID must be a decimal string"),
});

export async function adminAigcRoutes(app: FastifyInstance) {
  app.post("/aigc/generate", async (req: any, reply: any) => {
    const data = aigcGenerateSchema.parse(req.body);
    const locale = data.locale || "en";
    const promptVersion = data.promptVersion || "v1";
    const idStr = data.figureId.toString();
    const entry = JSON.stringify({ figureId: idStr, locale, promptVersion, createdAt: new Date().toISOString() });
    await app.redis.rpush("aigc:queue", entry);
    return reply.status(201).send({ success: true, data: { figureId: idStr, locale, promptVersion, status: "queued" } });
  });

  app.get("/aigc/status/:figureId", async (req: any, reply: any) => {
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
    const inQueue = queue.some((entry: string) => {
      try {
        const parsed = JSON.parse(entry);
        return parsed.figureId === figureId;
      } catch { return false; }
    });
    if (inQueue) {
      return { success: true, data: { figureId, status: "queued" } };
    }
    return { success: true, data: { figureId, status: "not_found" } };
  });
}
