export const APPLY_STAGES = [
  "VALIDATING", "FIGURE_WRITE", "RELATION_WRITE", "IMAGE_PROCESSING",
  "REVISION_WRITE", "CURRENT_REVISION_UPDATE", "REVIEW_STATUS_UPDATE", "CACHE_INVALIDATION",
] as const;
export type ApplyStage = (typeof APPLY_STAGES)[number];

export interface ApplyResult {
  success: boolean;
  data?: {
    applied: any;
    reviewStatus?: string;
    failureStage?: string | null;
    problems?: string[];
  };
  stage?: ApplyStage;
  error?: string;
  code?: string;
  cacheInvalidationPending?: boolean;
}
