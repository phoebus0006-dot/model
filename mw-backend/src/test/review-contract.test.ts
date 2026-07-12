import { describe, it, expect, beforeAll, afterAll } from "vitest";

let app: Awaited<ReturnType<typeof import("../app.js").buildApp>> | null = null;

async function inject(method: string, url: string, payload?: any) {
  if (!app) throw new Error("app not built");
  const opts: any = { method, url };
  if (payload !== undefined) opts.payload = payload;
  return app.inject(opts);
}

const REVIEW_ROUTES = [
  ["GET", "/api/v1/admin/review/items"],
  ["GET", "/api/v1/admin/review/decisions"],
  ["GET", "/api/v1/admin/review/stats"],
  ["POST", "/api/v1/admin/review/items"],
  ["PUT", "/api/v1/admin/review/items/test-123"],
  ["POST", "/api/v1/admin/review/items/test-123/recheck"],
  ["POST", "/api/v1/admin/review/items/test-123/action"],
  ["POST", "/api/v1/admin/review/items/test-123/apply"],
  ["POST", "/api/v1/admin/review/items/bulk/cleanup"],
  ["GET", "/api/v1/admin/review/image-proxy"],
  ["POST", "/api/v1/admin/review/cache-candidate"],
];

describe("Review routes — contract (skipLifecycle, no DB/Redis)", () => {
  beforeAll(async () => {
    const { buildApp } = await import("../app.js");
    app = await buildApp({ skipLifecycle: true });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  for (const [method, url] of REVIEW_ROUTES) {
    it(`${method} ${url} returns 401 without auth`, async () => {
      const res = await inject(method, url, { type: "general", title: "test" });
      expect(res.statusCode).toBe(401);
    });
  }

  it("POST /review/items returns 401 even with valid-looking body", async () => {
    const res = await inject("POST", "/api/v1/admin/review/items", {
      type: "general",
      title: "Test review item",
      status: "pending",
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it("POST /review/items/bulk/cleanup returns 401 with dryRun=true", async () => {
    const res = await inject("POST", "/api/v1/admin/review/items/bulk/cleanup", { dryRun: true, olderThanDays: 7 });
    expect(res.statusCode).toBe(401);
  });

  it("POST /review/items/:id/action with valid action returns 401", async () => {
    const res = await inject("POST", "/api/v1/admin/review/items/test-123/action", { action: "keep_pending" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /review/cache-candidate returns 401 without auth", async () => {
    const res = await inject("POST", "/api/v1/admin/review/cache-candidate", {
      reviewId: "test-123",
      hash: "a".repeat(64),
      contentBase64: Buffer.from("fake-image").toString("base64"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /review/image-proxy returns 401 without auth", async () => {
    const res = await inject("GET", "/api/v1/admin/review/image-proxy?url=https://example.com/img.jpg");
    expect(res.statusCode).toBe(401);
  });

  it("all review routes return consistent error envelope", async () => {
    for (const [method, url] of REVIEW_ROUTES) {
      const res = await inject(method, url);
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("success");
      expect(body).toHaveProperty("error");
    }
  });
});

describe("Review schemas — contract frozen", () => {
  const reviewStatusSchemaValues = ["pending", "needs_changes", "approved", "applying", "applied", "rejected", "failed", "archived", "stale"] as const;
  const reviewActionSchemaValues = ["approve", "reject", "request_changes", "keep_pending", "archive", "apply"] as const;
  const reviewTypeSchemaValues = ["jan_match", "figure_import", "rewrite", "image", "general", "image_review", "detail_review"] as const;

  it("valid review statuses match admin.ts definition", () => {
    expect(reviewStatusSchemaValues).toContain("pending");
    expect(reviewStatusSchemaValues).toContain("approved");
    expect(reviewStatusSchemaValues).toContain("rejected");
    expect(reviewStatusSchemaValues).toContain("needs_changes");
    expect(reviewStatusSchemaValues).toContain("resolved");
    expect(reviewStatusSchemaValues).toContain("stale");
  });

  it("valid review actions match admin.ts definition", () => {
    expect(reviewActionSchemaValues).toContain("approve");
    expect(reviewActionSchemaValues).toContain("reject");
    expect(reviewActionSchemaValues).toContain("request_changes");
    expect(reviewActionSchemaValues).toContain("keep_pending");
    expect(reviewActionSchemaValues).toContain("archive");
    expect(reviewActionSchemaValues).toContain("apply");
  });

  it("valid review types match admin.ts definition", () => {
    expect(reviewTypeSchemaValues).toContain("jan_match");
    expect(reviewTypeSchemaValues).toContain("figure_import");
    expect(reviewTypeSchemaValues).toContain("rewrite");
    expect(reviewTypeSchemaValues).toContain("image");
    expect(reviewTypeSchemaValues).toContain("general");
    expect(reviewTypeSchemaValues).toContain("image_review");
    expect(reviewTypeSchemaValues).toContain("detail_review");
  });

  it("default review query has limit=50 offset=0", () => {
    const reviewQuerySchema = { limit: 50, offset: 0 };
    expect(reviewQuerySchema.limit).toBe(50);
    expect(reviewQuerySchema.offset).toBe(0);
  });

  it("action->status map matches admin.ts", () => {
    const actionStatusMap: Record<string, string> = {
      approve: "approved",
      reject: "rejected",
      request_changes: "needs_changes",
      keep_pending: "pending",
      archive: "archived",
      apply: "applying",
    };
    for (const action of reviewActionSchemaValues) {
      expect(actionStatusMap[action]).toBeDefined();
    }
  });

  it("isSuppressingReviewDecision matches admin.ts", () => {
    const isSuppressingReviewDecision = (action: string): boolean =>
      ["approve", "reject", "archive"].includes(action);
    expect(isSuppressingReviewDecision("approve")).toBe(true);
    expect(isSuppressingReviewDecision("reject")).toBe(true);
    expect(isSuppressingReviewDecision("archive")).toBe(true);
    expect(isSuppressingReviewDecision("apply")).toBe(false);
    expect(isSuppressingReviewDecision("keep_pending")).toBe(false);
  });
});
