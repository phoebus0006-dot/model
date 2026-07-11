import type { FastifyInstance } from "fastify";
import type { ApplyContext } from "./apply-business.js";
import { applyFigureImport, applyImageReview, applyItemStatus, type ApplyActor } from "./apply-business.js";

export async function applyByType(context: ApplyContext, item: any, id: string, actor: ApplyActor, body: Record<string, unknown>) {
  const action = String(body.action || item.suggestedAction || "approve_image");
  switch (item.type) {
    case "figure_import":
      return applyFigureImport({ context, item, id, actor, body, action });
    case "image_review":
      return applyImageReview({ context, item, id, actor, body, action });
    default:
      throw new Error(`Unsupported review type: ${item.type}`);
  }
}
