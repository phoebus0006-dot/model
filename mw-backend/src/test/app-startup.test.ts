import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";

const ADMIN_REVIEW_ROUTES = [
  ["GET", "/api/v1/admin/review/items"],
  ["GET", "/api/v1/admin/review/decisions"],
  ["GET", "/api/v1/admin/review/stats"],
  ["POST", "/api/v1/admin/review/items"],
  ["PUT", "/api/v1/admin/review/items/:id"],
  ["POST", "/api/v1/admin/review/items/:id/recheck"],
  ["POST", "/api/v1/admin/review/items/:id/action"],
  ["POST", "/api/v1/admin/review/items/:id/apply"],
  ["POST", "/api/v1/admin/review/items/bulk/cleanup"],
  ["GET", "/api/v1/admin/review/image-proxy"],
  ["POST", "/api/v1/admin/review/cache-candidate"],
];

describe("App startup — no duplicate routes", () => {
  let app: any;

  beforeAll(async () => {
    app = await buildApp({ skipLifecycle: true });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("buildApp creates a valid app instance", () => {
    expect(app).toBeDefined();
    expect(app.ready).toBeDefined();
  });

  it("app.ready() does not have duplicate route errors", async () => {
    try {
      await app.ready();
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes("FST_ERR_DUPLICATED_ROUTE") || msg.includes("already declared")) {
        throw new Error(`Duplicate route detected: ${msg}`);
      }
      // Other errors (e.g., missing Redis/DB in skipLifecycle mode) are acceptable
    }
  });

  it("each admin review route is registered exactly once (must NOT be 404)", async () => {
    for (const [method, url] of ADMIN_REVIEW_ROUTES) {
      const res = await app.inject({ method, url });
      // Routes must be registered. 401 = exists but unauthorized, which is expected.
      // 404 = route not registered at all — fail.
      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).toBe(401);
    }
  });

  it("admin routes return 401 without auth (contract preserved)", async () => {
    for (const [method, url] of ADMIN_REVIEW_ROUTES) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
    }
  });
});
