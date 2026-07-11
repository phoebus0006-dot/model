import { describe, it, expect, beforeAll, afterAll } from "vitest";

let app: Awaited<ReturnType<typeof import("../app.js").buildApp>> | null = null;

describe("Admin API — auth contract (skipLifecycle, no DB)", () => {
  beforeAll(async () => {
    const { buildApp } = await import("../app.js");
    app = await buildApp({ skipLifecycle: true });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("rejects unauthenticated requests with 401", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/stats" });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects requests with malformed authorization header", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: { authorization: "Bearer invalid" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects all admin routes without valid auth", async () => {
    if (!app) throw new Error("app not built");
    const adminRoutes = [
      ["GET", "/api/v1/admin/stats"],
      ["GET", "/api/v1/admin/users"],
      ["GET", "/api/v1/admin/review/items"],
      ["GET", "/api/v1/admin/review/stats"],
      ["POST", "/api/v1/admin/cache/purge"],
      ["POST", "/api/v1/admin/aigc/generate"],
      ["GET", "/api/v1/admin/crawler/jobs"],
    ];
    for (const [method, url] of adminRoutes) {
      const res = await app.inject({ method: method as any, url });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("success");
      expect(body).toHaveProperty("error");
    }
  });

  it("error shape is consistent across all unauthenticated admin routes", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/users" });
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      success: false,
      error: { code: "UNAUTHORIZED" },
    });
  });
});

describe("Admin API — stats contract (auth gated)", () => {
  beforeAll(async () => {
    const { buildApp } = await import("../app.js");
    app = await buildApp({ skipLifecycle: true });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("stats endpoint exists and returns 401 without auth", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/stats" });
    expect(res.statusCode).toBe(401);
  });

  it("users endpoint exists and returns 401 without auth", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/users" });
    expect(res.statusCode).toBe(401);
  });
});

describe("Admin API — cache purge contract (auth gated)", () => {
  beforeAll(async () => {
    const { buildApp } = await import("../app.js");
    app = await buildApp({ skipLifecycle: true });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("cache purge returns 401 without auth", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/cache/purge",
      payload: { pattern: "figures:detail:*" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("cache purge with arbitrary patterns returns 401 without auth", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/cache/purge",
      payload: { pattern: "user:*" },
    });
    expect(res.statusCode).toBe(401);
  });
});
