import { z } from "zod";

export const figureImportPayloadSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  nameJp: z.string().optional(),
  nameEn: z.string().optional(),
  janCode: z.string().optional(),
  scale: z.string().optional(),
  material: z.string().optional(),
  priceJpy: z.number().int().optional(),
  releaseDate: z.string().optional(),
  heightMm: z.number().int().optional(),
  weightG: z.number().int().optional(),
  description: z.string().optional(),
  productLine: z.string().optional(),
  mfcId: z.string().optional(),
  ageRating: z.string().optional(),
  hobbySearchId: z.string().optional(),
  amiamiId: z.string().optional(),
  hljId: z.string().optional(),
  categoryIds: z.array(z.number().int()).optional(),
  sculptorIds: z.array(z.object({ id: z.number().int(), role: z.string().optional(), isPrimary: z.boolean().optional() })).optional(),
  characterIds: z.array(z.object({ id: z.number().int(), isFeatured: z.boolean().optional() })).optional(),
  images: z.array(z.object({ source: z.string(), alt: z.string().optional(), sortOrder: z.number().int().optional() })).optional(),
  localized: z.array(z.object({ language: z.string(), title: z.string().optional(), origin: z.string().optional(), character: z.string().optional(), description: z.string().optional() })).optional(),
  releases: z.array(z.object({ edition: z.string(), releaseDate: z.string().optional(), priceJpy: z.number().int().optional(), isRerelease: z.boolean().optional() })).optional(),
  importImages: z.boolean().optional(),
}).strict();
export type FigureImportDTO = z.infer<typeof figureImportPayloadSchema>;

export const janMatchPayloadSchema = z.object({
  janCode: z.string().min(1),
  figureId: z.union([z.string(), z.number()]).optional(),
}).strict();
export type JanMatchDTO = z.infer<typeof janMatchPayloadSchema>;

export const rewritePayloadSchema = z.object({
  description: z.string().optional(),
  contentMd: z.string().optional(),
  summaryMd: z.string().optional(),
  keyPoints: z.array(z.string()).optional(),
  relatedKeywords: z.array(z.string()).optional(),
  editSummary: z.string().optional(),
}).strict();
export type RewriteDTO = z.infer<typeof rewritePayloadSchema>;

export const imagePayloadSchema = z.object({
  source: z.string(),
  alt: z.string().optional(),
  sortOrder: z.number().int().optional(),
  isNsfw: z.boolean().optional(),
}).strict();
export type ImageDTO = z.infer<typeof imagePayloadSchema>;

export const imageReviewPayloadSchema = z.object({
  action: z.enum(["approve", "reject", "keep_pending"]).optional(),
}).strict();
export type ImageReviewDTO = z.infer<typeof imageReviewPayloadSchema>;

export const APPLY_TYPE_SCHEMA_MAP: Record<string, z.ZodSchema> = {
  figure_import: figureImportPayloadSchema,
  jan_match: janMatchPayloadSchema,
  rewrite: rewritePayloadSchema,
  image: imagePayloadSchema,
  image_review: imageReviewPayloadSchema,
};
