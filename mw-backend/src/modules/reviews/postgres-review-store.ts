import { PrismaClient, Prisma } from "@prisma/client";
import {
  type ReviewStore, type ReviewListQuery, type ReviewListResult,
  type CreateReviewInput, type TransitionReviewInput, type TransitionResult,
  type AppendReviewEventInput,
} from "./store-interface.js";

export class PostgresReviewStore implements ReviewStore {
  constructor(private prisma: PrismaClient) {}

  async getById(id: string): Promise<any | null> {
    const item = await this.prisma.reviewItem.findUnique({ where: { publicId: id } });
    if (!item) return null;
    return this.toDto(item);
  }

  async list(query: ReviewListQuery): Promise<ReviewListResult> {
    const where: any = {};
    if (query.status && query.status !== "all") where.status = query.status;
    if (query.type) where.type = query.type;
    if (query.riskType) where.riskType = query.riskType;
    if (query.suggestedAction) where.suggestedAction = query.suggestedAction;

    const [items, total] = await Promise.all([
      this.prisma.reviewItem.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.reviewItem.count({ where }),
    ]);

    return {
      items: items.map((i) => this.toDto(i)),
      meta: { count: items.length, total, limit: query.limit, offset: query.offset },
    };
  }

  async create(input: CreateReviewInput): Promise<any> {
    const now = new Date();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item = await this.prisma.reviewItem.create({
      data: {
        publicId: id,
        type: input.type || "general",
        title: input.title,
        source: input.source,
        sourceId: input.sourceId,
        status: input.status || "pending",
        priority: input.priority ?? 1,
        confidence: input.confidence != null ? input.confidence : undefined,
        figureId: input.figureId != null ? BigInt(String(input.figureId)) : undefined,
        figureSlug: input.figureSlug,
        riskType: input.riskType,
        riskReason: input.riskReason,
        suggestedAction: input.suggestedAction,
        evidenceFingerprint: input.evidenceFingerprint,
        payload: (input.payload as any) || undefined,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      },
    });

    await this.appendEvent({
      reviewId: item.publicId,
      event: "create",
      toStatus: "pending",
      actor: "system",
    });

    return this.toDto(item);
  }

  async transition(input: TransitionReviewInput): Promise<TransitionResult> {
    const { id, action, targetStatus, expectedStatus, reviewer, reason, payload } = input;

    try {
      const result = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const existing = await tx.reviewItem.findUnique({ where: { publicId: id } });
        if (!existing) {
          return { success: false, error: "REVIEW_ITEM_NOT_FOUND", code: "NOT_FOUND" } as TransitionResult;
        }

        if (expectedStatus && expectedStatus !== "any" && existing.status !== expectedStatus) {
          return { success: false, error: `Expected status "${expectedStatus}", current is "${existing.status}"`, code: "STATUS_CONFLICT", status: existing.status } as TransitionResult;
        }

        const updated = await tx.reviewItem.update({
          where: { id: existing.id, version: existing.version },
          data: {
            status: targetStatus,
            version: { increment: 1 },
            reviewer: reviewer || existing.reviewer,
            decisionReason: reason || existing.decisionReason,
            decisionAt: ["approved", "rejected", "applied", "failed", "archived"].includes(targetStatus) ? new Date() : existing.decisionAt,
            payload: payload != null ? (payload as any) : existing.payload,
            updatedAt: new Date(),
          },
        });

        if (!updated) {
          return { success: false, error: "Version conflict — item was modified by another request", code: "CONFLICT" } as TransitionResult;
        }

        await tx.reviewEvent.create({
          data: {
            reviewItemId: updated.id,
            event: "action",
            action,
            fromStatus: existing.status,
            toStatus: targetStatus,
            actor: reviewer || "system",
            reason,
            createdAt: new Date(),
          },
        });

        return { success: true, status: targetStatus };
      });

      return result;
    } catch (err: any) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return { success: false, error: "Version conflict — item was modified by another request", code: "CONFLICT" };
      }
      return { success: false, error: err.message || "Transition failed", code: "INTERNAL_ERROR" };
    }
  }

  async appendEvent(input: AppendReviewEventInput): Promise<void> {
    const item = await this.prisma.reviewItem.findUnique({ where: { publicId: input.reviewId } });
    if (!item) throw new Error(`ReviewItem not found: ${input.reviewId}`);

    await this.prisma.reviewEvent.create({
      data: {
        reviewItemId: item.id,
        event: input.event,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        actor: input.actor || "system",
        reason: input.reason,
        metadata: input.metadata as any,
        createdAt: new Date(),
      },
    });
  }

  private toDto(item: any): any {
    return {
      id: item.publicId,
      type: item.type,
      title: item.title,
      source: item.source,
      sourceId: item.sourceId,
      status: item.status,
      priority: item.priority,
      confidence: item.confidence ? Number(item.confidence) : undefined,
      figureId: item.figureId ? String(item.figureId) : undefined,
      figureSlug: item.figureSlug,
      riskType: item.riskType,
      riskReason: item.riskReason,
      suggestedAction: item.suggestedAction,
      evidenceFingerprint: item.evidenceFingerprint,
      reviewer: item.reviewer,
      decisionReason: item.decisionReason,
      decisionAt: item.decisionAt?.toISOString() || null,
      payload: item.payload,
      notes: item.notes,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      version: item.version,
    };
  }
}
