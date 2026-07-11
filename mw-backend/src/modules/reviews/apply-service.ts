import type { Redis } from "ioredis";
import type { PrismaClient } from "@prisma/client";
import { tryAcquire, type LockLease } from "./apply-lock.js";
import { ReviewNotFound, InvalidReviewState, ApplyLockConflict, ApplyDependencyError, ApplyValidationError } from "./apply-errors.js";
import type { ApplyResult } from "./apply-types.js";
import { applyFigureImport, applyImageReview, applyItemStatus, type ApplyContext, type ApplyActor } from "./apply-business.js";

export interface ApplyInput {
  reviewItemId: string;
  actor: ApplyActor;
  body: Record<string, unknown>;
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

      const context: ApplyContext = { redis: this.redis, prisma: this.prisma };
      const action = String(body.action || item.suggestedAction || "approve_image");
      const applyInput = { context, item, id: reviewItemId, actor, body, action };

      let output;
      switch (item.type) {
        case "figure_import":
          output = await applyFigureImport(applyInput);
          break;
        case "image_review":
          output = await applyImageReview(applyInput);
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
