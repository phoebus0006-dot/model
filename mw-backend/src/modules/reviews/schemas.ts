import { z } from "zod";
import { REVIEW_STATUSES, REVIEW_TYPES, REVIEW_RISK_TYPES, REVIEW_ACTIONS } from "./types.js";

export const reviewStatusSchema = z.enum(REVIEW_STATUSES);
export const queryReviewStatusSchema = z.union([reviewStatusSchema, z.literal("all")]);
export const reviewTypeSchema = z.enum(REVIEW_TYPES);
export const reviewRiskTypeSchema = z.enum(REVIEW_RISK_TYPES);
export const reviewActionSchema = z.enum(REVIEW_ACTIONS);

const automationSchema = z.object({
  provider: z.enum(["n8n", "hermes", "manual", "other"]).default("manual"),
  workflow: z.string().optional(),
  runId: z.string().optional(),
}).optional();

const candidateImageSchema = z.object({
  source: z.string(),
  imageId: z.union([z.number(), z.string()]).optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  fileSize: z.number().int().optional(),
  aspectRatio: z.number().optional(),
  url: z.string().optional(),
  cachedUrl: z.string().optional(),
}).passthrough().optional();

const currentPublicImageSchema = z.object({
  imageId: z.union([z.number(), z.string()]).optional(),
  source: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
}).optional();

const detailSnapshotSchema = z.object({
  description: z.string().optional(),
  specCount: z.number().int().optional(),
  specs: z.any().optional(),
  categories: z.array(z.any()).optional(),
}).optional();

export const reviewItemSchema = z.object({
  type: reviewTypeSchema.default("general"),
  title: z.string().min(1),
  source: z.string().optional(),
  sourceId: z.string().optional(),
  status: reviewStatusSchema.default("pending"),
  priority: z.coerce.number().int().min(0).max(3).default(1),
  confidence: z.coerce.number().min(0).max(1).optional(),
  figureId: z.union([z.number().int(), z.string()]).optional(),
  figureSlug: z.string().optional(),
  riskType: reviewRiskTypeSchema.optional(),
  riskReason: z.string().max(1000).optional(),
  candidateImage: candidateImageSchema,
  currentPublicImage: currentPublicImageSchema,
  detailSnapshot: detailSnapshotSchema,
  suggestedAction: reviewActionSchema.optional(),
  payload: z.any().optional(),
  notes: z.string().optional(),
  automation: automationSchema,
  evidenceFingerprint: z.string().min(16).max(128).optional(),
  decisionReason: z.string().max(1000).nullable().optional(),
  reviewer: z.string().max(200).nullable().optional(),
  decisionAt: z.string().datetime().nullable().optional(),
});

export const candidateImageUpdateSchema = z.object({
  source: z.string(),
  imageId: z.union([z.number(), z.string()]).optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  fileSize: z.number().int().optional(),
  aspectRatio: z.number().optional(),
  url: z.string().optional(),
  cachedUrl: z.string().optional(),
}).passthrough().optional();

export const reviewUpdateSchema = z.object({
  status: reviewStatusSchema.optional(),
  priority: z.coerce.number().int().min(0).max(3).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  payload: z.any().optional(),
  notes: z.string().max(2000).optional(),
  automation: automationSchema,
  candidateImage: candidateImageUpdateSchema,
  suggestedAction: reviewActionSchema.optional(),
  currentPublicImage: currentPublicImageSchema,
  evidenceFingerprint: z.string().min(16).max(128).optional(),
  decisionReason: z.string().max(1000).nullable().optional(),
  reviewer: z.string().max(200).nullable().optional(),
  decisionAt: z.string().datetime().nullable().optional(),
});

// Safe editable fields — explicitly excludes status, reviewer, decisionReason, decisionAt
export const reviewEditableFieldsSchema = z.object({
  priority: z.coerce.number().int().min(0).max(3).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  payload: z.any().optional(),
  notes: z.string().max(2000).optional(),
  automation: automationSchema,
  candidateImage: candidateImageUpdateSchema,
  suggestedAction: reviewActionSchema.optional(),
  currentPublicImage: currentPublicImageSchema,
  evidenceFingerprint: z.string().min(16).max(128).optional(),
}).strict();

export const reviewQuerySchema = z.object({
  status: queryReviewStatusSchema.optional(),
  type: reviewTypeSchema.optional(),
  riskType: reviewRiskTypeSchema.optional(),
  suggestedAction: reviewActionSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const reviewDecisionQuerySchema = z.object({
  figureId: z.string().trim().min(1).optional(),
  figureSlug: z.string().trim().min(1).optional(),
  riskType: reviewRiskTypeSchema.optional(),
  action: reviewActionSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const bulkCleanupSchema = z.object({
  dryRun: z.boolean().default(false),
  markStale: z.boolean().default(true),
  olderThanDays: z.coerce.number().int().min(1).default(1),
});
