export const APPLY_STAGES = [
  "VALIDATING", "FIGURE_WRITE", "RELATION_WRITE", "IMAGE_PROCESSING",
  "REVISION_WRITE", "CURRENT_REVISION_UPDATE", "REVIEW_STATUS_UPDATE", "CACHE_INVALIDATION",
] as const;
export type ApplyStage = (typeof APPLY_STAGES)[number];

export interface ApplyInput {
  reviewItemId: string;
  actorUserId?: string;
  requestId?: string;
}

export interface ApplyResult {
  success: boolean;
  stage?: ApplyStage;
  error?: string;
  code?: string;
  cacheInvalidationPending?: boolean;
}
