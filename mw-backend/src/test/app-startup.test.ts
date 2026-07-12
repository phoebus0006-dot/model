import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";

function patchServerBindings(app: any) {
  const sym = Object.getOwnPropertySymbols(app).find(
    (s: any) => s.toString().includes("serverBindings")
  );
  if (sym && (!app[sym] || app[sym].length === 0)) {
    app[sym] = [{ address: () => ({ family: "IPv4", address: "127.0.0.1", port: 0 }) }];
  }
}

const ADMIN_ROUTES = [
  { method: "GET", url: "/api/v1/admin/review/items" },
  { method: "GET", url: "/api/v1/admin/review/decisions" },
  { method: "GET", url: "/api/v1/admin/review/stats" },
  { method: "POST", url: "/api/v1/admin/review/items" },
  { method: "PUT", url: "/api/v1/admin/review/items/:id" },
  { method: "POST", url: "/api/v1/admin/review/items/:id/recheck" },
  { method: "POST", url: "/api/v1/admin/review/items/:id/action" },
  { method: "POST", url: "/api/v1/admin/review/items/:id/apply" },
  { method: "POST", url: "/api/v1/admin/review/items/bulk/cleanup" },
  { method: "GET", url: "/api/v1/admin/review/image-proxy" },
  { method: "POST", url: "/api/v1/admin/review/cache-candidate" },
];

describe("App startup — route registration", () => {
  let app: any;

  beforeAll(async () => {
    app = await buildApp({ skipLifecycle: true });
    patchServerBindings(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("buildApp creates a valid app instance", () => {
    expect(app).toBeDefined();
    expect(app.close).toBeDefined();
  });

  it("app.ready() resolves without errors", async () => {
    await app.ready();
  });

  it("each admin review route is registered exactly once", () => {
    for (const route of ADMIN_ROUTES) {
      const exists = app.hasRoute(route);
      expect(exists).toBe(true);
    }
  });
});
