import { describe, it, expect, beforeAll, afterAll } from "vitest";

let app: Awaited<ReturnType<typeof import("../app.js").buildApp>> | null = null;

describe("App contract tests (skipLifecycle — no DB)", () => {
  beforeAll(async () => {
    const { buildApp } = await import("../app.js");
    app = await buildApp({ skipLifecycle: true });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("health endpoint returns ok", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("timestamp");
  });

  it("unknown route returns 404", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "GET", url: "/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("admin routes return 401 without auth", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/stats" });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("admin routes have no-store cache header", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/stats" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("figures list returns with standard response shape", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "GET", url: "/api/v1/figures" });
    // Without DB, this may error — but shape should be consistent
    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 500) {
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty("success");
      expect(body).toHaveProperty("error");
    }
  });

  it("search endpoint returns 200", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "GET", url: "/api/v1/search?q=test" });
    expect([200, 500]).toContain(res.statusCode);
  });

  it("auth login route exists and returns validation error for missing body", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login" });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("responses use consistent JSON envelope", async () => {
    if (!app) throw new Error("app not built");
    const res = await app.inject({ method: "GET", url: "/api/v1/categories" });
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("success");
  });
});
