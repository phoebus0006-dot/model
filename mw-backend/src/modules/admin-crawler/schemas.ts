import { z } from "zod";

export const crawlerRunnerSchema = z.enum(["server_safe", "local_browser", "proxy_browser", "manual"]);
export const crawlerJobStatusSchema = z.enum(["queued", "claimed", "running", "succeeded", "failed", "deferred", "cancelled"]);

export const crawlerJobSchema = z.object({
  source: z.string().min(1),
  task: z.string().min(1),
  runner: crawlerRunnerSchema.default("server_safe"),
  status: crawlerJobStatusSchema.default("queued"),
  priority: z.coerce.number().int().min(0).max(3).default(1),
  payload: z.any().optional(),
  notBefore: z.string().datetime().optional(),
  maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
  notes: z.string().optional(),
  automation: z.object({
    provider: z.enum(["n8n", "hermes", "manual", "other"]).default("manual"),
    workflow: z.string().optional(),
    runId: z.string().optional(),
  }).optional(),
});

export const crawlerJobUpdateSchema = z.object({
  status: crawlerJobStatusSchema.optional(),
  runner: crawlerRunnerSchema.optional(),
  priority: z.coerce.number().int().min(0).max(3).optional(),
  payload: z.any().optional(),
  result: z.any().optional(),
  resultSummary: z.any().optional(),
  error: z.string().optional(),
  notes: z.string().optional(),
  notBefore: z.string().datetime().nullable().optional(),
});

export const crawlerJobQuerySchema = z.object({
  status: crawlerJobStatusSchema.optional(),
  runner: crawlerRunnerSchema.optional(),
  source: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const crawlerClaimSchema = z.object({
  runner: crawlerRunnerSchema,
  workerId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(10).default(1),
});
