export const REVIEW_STORE_MODES = ["redis", "dual", "postgres"] as const;
export type ReviewStoreMode = (typeof REVIEW_STORE_MODES)[number];

export function resolveReviewStoreMode(envValue?: string): ReviewStoreMode {
  if (!envValue) return "redis";
  const normalized = envValue.trim().toLowerCase() as ReviewStoreMode;
  if (!REVIEW_STORE_MODES.includes(normalized)) {
    throw new Error(
      `Invalid REVIEW_STORE_MODE="${envValue}". Must be one of: ${REVIEW_STORE_MODES.join(", ")}. ` +
      "Fail fast to prevent silent fallback to wrong store."
    );
  }
  return normalized;
}

export interface ReviewListQuery {
  status?: string;
  type?: string;
  riskType?: string;
  suggestedAction?: string;
  limit: number;
  offset: number;
}

export interface ReviewListResult {
  items: any[];
  meta: { count: number; total: number; limit: number; offset: number };
}

export interface CreateReviewInput {
  type: string;
  title: string;
  source?: string;
  sourceId?: string;
  status?: string;
  priority?: number;
  confidence?: number;
  figureId?: string | number;
  figureSlug?: string;
  riskType?: string;
  riskReason?: string;
  candidateImage?: any;
  currentPublicImage?: any;
  detailSnapshot?: any;
  suggestedAction?: string;
  payload?: Record<string, unknown>;
  notes?: string;
  automation?: any;
  evidenceFingerprint?: string;
}

export interface TransitionReviewInput {
  id: string;
  action: string;
  targetStatus: string;
  expectedStatus?: string;
  reviewer?: string;
  reason?: string | null;
  payload?: Record<string, unknown>;
}

export interface TransitionResult {
  success: boolean;
  status?: string;
  error?: string;
  code?: string;
}

export interface AppendReviewEventInput {
  reviewId: string;
  event: string;
  fromStatus?: string;
  toStatus: string;
  actor?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface ReviewStore {
  getById(id: string): Promise<any | null>;
  list(query: ReviewListQuery): Promise<ReviewListResult>;
  create(input: CreateReviewInput): Promise<any>;
  transition(input: TransitionReviewInput): Promise<TransitionResult>;
  appendEvent(input: AppendReviewEventInput): Promise<void>;
}
