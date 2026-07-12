import type { Redis } from "ioredis";
import type { PrismaClient } from "@prisma/client";
import { tryAcquire, type LockLease } from "./apply-lock.js";
import { ReviewNotFound, InvalidReviewState, ApplyLockConflict, ApplyDependencyError, ApplyValidationError } from "./apply-errors.js";
import type { ApplyResult } from "./apply-types.js";
import { applyFigureImport, applyJanMatch, applyRewrite, applyImage, applyImageReview, applyItemStatus, type ApplyContext, type ApplyActor } from "./apply-business.js";
import { APPLY_TYPE_SCHEMA_MAP } from "./apply-schemas.js";
import type { TypedApplyDTO } from "./apply-types.js";

export interface ApplyInput {
  reviewItemId: string;
  actor: ApplyActor;
  body: Record<string, unknown>;
}

function parseApplyBody(item: any, body: Record<string, unknown>): TypedApplyDTO {
  const schema = APPLY_TYPE_SCHEMA_MAP[item.type];
  if (!schema) {
    throw new ApplyValidationError(`Unsupported review type: ${item.type}`);
  }
  const merged = { ...(item.payload || {}), ...body };
  return schema.parse(merged) as TypedApplyDTO;
}

export class ReviewApplyService {
  constructor(private redis: Redis, private prisma: PrismaClient) {}

  async apply(input: ApplyInput): Promise<ApplyResult> {
    const { reviewItemId, actor, body } = input;

    const preRaw = await this.redis.get(`review:item:${reviewItemId}`);
    if (!preRaw) throw new ReviewNotFound(reviewItemId);

    const lease = await tryAcquire(this.redis, reviewItemId);
    if (!lease) throw new ApplyLockConflict(reviewItemId);

    try {
      lease.assertHeld();
      const raw = await this.redis.get(`review:item:${reviewItemId}`);
      if (!raw) throw new ReviewNotFound(reviewItemId);
      const item = JSON.parse(raw);
      if (item.status !== "pending" && item.status !== "needs_changes") {
        throw new InvalidReviewState(item.status, "pending or needs_changes");
      }
      lease.assertHeld();

      const dto = parseApplyBody(item, body);
      const context: ApplyContext = {
        redis: this.redis,
        prisma: this.prisma,
        verifyLock: () => lease.verifyHeld(this.redis),
      };
      const action = String(body.action || item.suggestedAction || "approve_image");

      let output;
      switch (item.type) {
        case "figure_import":
          output = await applyFigureImport(context, item, reviewItemId, actor, dto as any, action);
          break;
        case "jan_match":
          output = await applyJanMatch(context, item, reviewItemId, actor, dto as any, action);
          break;
        case "rewrite":
          output = await applyRewrite(context, item, reviewItemId, actor, dto as any, action);
          break;
        case "image":
          output = await applyImage(context, item, reviewItemId, actor, dto as any, action);
          break;
        case "image_review":
          output = await applyImageReview(context, item, reviewItemId, actor, dto as any, action);
          break;
        default:
          throw new ApplyValidationError(`Unsupported review type: ${item.type}`);
      }

      const reviewStatus = await applyItemStatus(context, reviewItemId, item, output);

      return {
        success: output.failure ? false : true,
        data: { applied: output, reviewStatus, failureStage: output.failure?.stage || null, problems: output.failure?.problems || [] },
      };
    } catch (e: any) {
      if (e instanceof ReviewNotFound || e instanceof InvalidReviewState ||
          e instanceof ApplyLockConflict || e instanceof ApplyDependencyError ||
          e instanceof ApplyValidationError) {
        throw e;
      }
      throw new ApplyDependencyError(e.message || "Apply failed", "apply");
    } finally {
      await lease.release().catch(() => {});
    }
  }
}
