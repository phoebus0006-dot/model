import type { FastifyInstance } from "fastify";
import type { ApplyContext, ApplyActor } from "./apply-business.js";
import { applyFigureImport, applyJanMatch, applyRewrite, applyImage, applyImageReview, applyItemStatus } from "./apply-business.js";
import { APPLY_TYPE_SCHEMA_MAP } from "./apply-schemas.js";

export async function applyByType(context: ApplyContext, item: any, id: string, actor: ApplyActor, body: Record<string, unknown>) {
  const action = String(body.action || item.suggestedAction || "approve_image");
  const schema = APPLY_TYPE_SCHEMA_MAP[item.type];
  if (!schema) throw new Error(`Unsupported review type: ${item.type}`);
  const merged = { ...(item.payload || {}), ...body };
  const dto = schema.parse(merged);

  switch (item.type) {
    case "figure_import":
      return applyFigureImport(context, item, id, actor, dto as any, action);
    case "jan_match":
      return applyJanMatch(context, item, id, actor, dto as any, action);
    case "rewrite":
      return applyRewrite(context, item, id, actor, dto as any, action);
    case "image":
      return applyImage(context, item, id, actor, dto as any, action);
    case "image_review":
      return applyImageReview(context, item, id, actor, dto as any, action);
    default:
      throw new Error(`Unsupported review type: ${item.type}`);
  }
}
