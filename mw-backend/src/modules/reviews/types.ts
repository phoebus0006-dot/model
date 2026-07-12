export const REVIEW_STATUSES = ["pending", "approved", "rejected", "needs_changes", "resolved", "applied", "failed", "stale"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_TYPES = ["jan_match", "figure_import", "rewrite", "image", "general", "image_review", "detail_review"] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];

export const REVIEW_RISK_TYPES = [
  "image_suspicious_banner", "image_suspicious_thumbnail", "image_possible_user_photo",
  "image_possible_collection_or_room", "image_wrong_subject", "image_low_quality_fallback",
  "image_restore_candidate", "image_missing", "image_low_count",
  "detail_missing_description", "detail_sparse_specs", "detail_conflict",
  "category_uncertain", "general_risk",
] as const;
export type ReviewRiskType = (typeof REVIEW_RISK_TYPES)[number];

export const REVIEW_ACTIONS = [
  "approve_image", "reject_image", "keep_placeholder", "mark_detail_ok",
  "request_refetch", "dismiss_stale", "keep_pending",
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export interface CandidateImage {
  source: string;
  imageId?: number | string;
  width?: number;
  height?: number;
  fileSize?: number;
  aspectRatio?: number;
  url?: string;
  cachedUrl?: string;
  [key: string]: unknown;
}

export interface CurrentPublicImage {
  imageId?: number | string;
  source?: string;
  width?: number;
  height?: number;
}

export interface DetailSnapshot {
  description?: string;
  specCount?: number;
  specs?: unknown;
  categories?: unknown[];
  [key: string]: unknown;
}

export interface AutomationInfo {
  provider: "n8n" | "hermes" | "manual" | "other";
  workflow?: string;
  runId?: string;
}

export interface ReviewItem {
  id: string;
  type: ReviewType;
  title: string;
  source?: string;
  sourceId?: string;
  status: ReviewStatus;
  priority: number;
  confidence?: number;
  figureId?: string | number;
  figureSlug?: string;
  riskType?: ReviewRiskType;
  riskReason?: string;
  candidateImage?: CandidateImage;
  currentPublicImage?: CurrentPublicImage;
  detailSnapshot?: DetailSnapshot;
  suggestedAction?: ReviewAction;
  payload?: Record<string, unknown>;
  notes?: string;
  automation?: AutomationInfo;
  evidenceFingerprint?: string;
  decisionReason?: string | null;
  reviewer?: string | null;
  decisionAt?: string | null;
  currentStateEvidence?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewDecision {
  reviewItemId: string | null;
  figure: string | null;
  type: string | null;
  riskType: string | null;
  evidenceFingerprint: string | null;
  action: string | null;
  status: string | null;
  reviewer: string | null;
  decisionReason: string | null;
  decisionAt: string | null;
}

export interface BulkCleanupResult {
  updatedCount: number;
  skippedCount: number;
  totalScanned: number;
  dryRun: boolean;
  sampleUpdated: string[];
}

export interface ApplyResult {
  item: ReviewItem;
  applied: unknown;
  problems: string[];
}

export type ReviewRecord = Record<string, unknown>;

export const SUPPRESSING_ACTIONS: readonly ReviewAction[] = [
  "approve_image", "reject_image", "keep_placeholder", "mark_detail_ok", "dismiss_stale",
];

export const ACTION_STATUS_MAP: Record<ReviewAction, ReviewStatus> = {
  approve_image: "approved",
  reject_image: "rejected",
  keep_placeholder: "resolved",
  mark_detail_ok: "resolved",
  request_refetch: "needs_changes",
  dismiss_stale: "resolved",
  keep_pending: "pending",
};

export function isSuppressingAction(action: string): boolean {
  return SUPPRESSING_ACTIONS.includes(action as ReviewAction);
}
