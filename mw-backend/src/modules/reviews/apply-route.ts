import type { FastifyInstance } from "fastify";
import { ReviewApplyService } from "./apply-service.js";
import { ReviewNotFound, InvalidReviewState, ApplyLockConflict, ApplyDependencyError, ApplyValidationError } from "./apply-errors.js";

export async function adminApplyRoute(app: FastifyInstance) {
  const applyService = new ReviewApplyService(app.redis, app.prisma);

  app.post("/review/items/:id/apply", async (req: any, reply: any) => {
    try {
      const actor = {
        userId: String(req.user?.userId || req.user?.id || ""),
        displayName: String(req.user?.displayName || req.user?.username || "system"),
      };
      const body = req.body || {};
      const result = await applyService.apply({
        reviewItemId: String(req.params.id),
        actor,
        body,
      });
      const payload: any = result.data || {};
      if (result.success && payload.applied?.success !== false) {
        return reply.send({
          success: true,
          data: payload.applied,
          reviewStatus: payload.reviewStatus,
          actor,
          action: payload.applied?.action,
        });
      }
      return reply.status(422).send({
        success: false,
        error: {
          code: "APPLY_BUSINESS_FAILED",
          message: "Apply completed with business failures",
          failureStage: payload.failureStage,
          problems: payload.problems,
          action: payload.applied?.action,
        },
      });
    } catch (e: any) {
      if (e instanceof ReviewNotFound) return reply.status(404).send({ success: false, error: { code: e.code, message: e.message } });
      if (e instanceof InvalidReviewState) return reply.status(409).send({ success: false, error: { code: e.code, message: e.message } });
      if (e instanceof ApplyLockConflict) return reply.status(409).send({ success: false, error: { code: e.code, message: e.message } });
      if (e instanceof ApplyDependencyError) return reply.status(422).send({ success: false, error: { code: e.code, message: e.message, stage: e.stage } });
      if (e instanceof ApplyValidationError) return reply.status(422).send({ success: false, error: { code: e.code, message: e.message } });
      return reply.status(500).send({ success: false, error: { code: "APPLY_INTERNAL_ERROR", message: "Internal error during apply" } });
    }
  });
}
