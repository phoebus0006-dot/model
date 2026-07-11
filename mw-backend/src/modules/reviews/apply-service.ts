import type { Redis } from "ioredis";
import type { PrismaClient } from "@prisma/client";
import { tryAcquire, type LockLease } from "./apply-lock.js";
import { ReviewNotFound, InvalidReviewState, ApplyLockConflict, ApplyDependencyError } from "./apply-errors.js";
import type { ApplyInput, ApplyResult } from "./apply-types.js";

export class ReviewApplyService {
  constructor(private redis: Redis, private prisma: PrismaClient) {}
  async apply(input: ApplyInput): Promise<ApplyResult> {
    const reviewItemId = input.reviewItemId;

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

      const { executeApplyLogic } = await import("./apply-handler.js");
      lease.assertHeld();
      const result = await executeApplyLogic({ redis: this.redis, prisma: this.prisma }, reviewItemId);
      lease.assertHeld();

      return { success: true };
    } finally {
      try { await lease.release(); } catch {}
    }
  }
}
