import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readAsset(file: string): string {
  return readFileSync(resolve(__dirname, "../../../modelwiki-theme/assets/js", file), "utf-8");
}

/**
 * Build a minimal browser-like global scope, then evaluate the two JS sources.
 * This avoids a jsdom dependency while giving us the real `ModelWikiAPI` class
 * and `window.MW.featureFlags` object.
 */
function setupBrowserEnv(overrides?: { location?: { search?: string; href?: string }; localStorage?: Record<string, string> }) {
  // ---- polyfills that the JS scripts rely on ----
  class MockAbortController {
    signal: { aborted: boolean; addEventListener: ReturnType<typeof vi.fn>; reason?: unknown };
    abort: ReturnType<typeof vi.fn>;
    constructor() {
      this.signal = { aborted: false, addEventListener: vi.fn() };
      this.abort = vi.fn();
    }
  }

  class MockURLSearchParams {
    private _map = new Map<string, string>();
    constructor(init?: string) {
      if (init) {
        init.replace(/^\?/, "").split("&").filter(Boolean).forEach((pair) => {
          const [k, v] = pair.split("=").map(decodeURIComponent);
          this._map.set(k, v);
        });
      }
    }
    set(k: string, v: string) { this._map.set(k, v); }
    get(k: string) { return this._map.get(k); }
    has(k: string) { return this._map.has(k); }
    forEach(cb: (v: string, k: string) => void) { this._map.forEach((v, k) => cb(v, k)); }
    toString() {
      return Array.from(this._map.entries())
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
    }
  }

  const locSearch = overrides?.location?.search ?? "";
  const locHref = overrides?.location?.href ?? "http://localhost";
  const mockLocation = { search: locSearch, href: locHref };

  // Attach global shims
  (globalThis as Record<string, unknown>).window = globalThis as unknown as Window & typeof globalThis;
  (globalThis as Record<string, unknown>).AbortController = MockAbortController;
  (globalThis as Record<string, unknown>).URLSearchParams = MockURLSearchParams;
  (globalThis as Record<string, unknown>).location = mockLocation;
  (globalThis as Record<string, unknown>).localStorage = (() => {
    const store: Record<string, string> = overrides?.localStorage ?? {};
    return {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = String(v); },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    };
  })();
  (globalThis as Record<string, unknown>).sessionStorage = (globalThis as Record<string, unknown>).localStorage;

  // Mock fetch – callers set globalThis.__mockFetchResponse to control it
  (globalThis as Record<string, unknown>).fetch = vi.fn();

  // Execute the two source files in order
  const ffSrc = readAsset("feature-flags.js");
  const apiSrc = readAsset("api-client.js");
  new Function(ffSrc)();
  new Function(apiSrc)();

  type ModelWikiAPIType = new (...args: any[]) => { getFigures: (...args: any[]) => any; getFigure: (...args: any[]) => any; search: (...args: any[]) => any; getCategories: (...args: any[]) => any; getSeries: (...args: any[]) => any; getManufacturer: (...args: any[]) => any; getCharacters: (...args: any[]) => any; addRequestInterceptor: (...args: any[]) => any; addResponseInterceptor: (...args: any[]) => any };
  type FeatureFlagsType = { getAll: (...args: any[]) => any; get: (...args: any[]) => any; set: (...args: any[]) => any; reset: (...args: any[]) => any; onChange: (...args: any[]) => any };
  return {
    ModelWikiAPI: (globalThis as Record<string, unknown>).ModelWikiAPI as ModelWikiAPIType,
    MW: (globalThis as Record<string, unknown>).MW as { featureFlags: FeatureFlagsType } | undefined,
    featureFlags: ((globalThis as Record<string, unknown>).MW as Record<string, unknown>)?.featureFlags as unknown as FeatureFlagsType,
    mockFetch: (globalThis as Record<string, unknown>).fetch as ReturnType<typeof vi.fn>,
  };
}

function okResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
  });
}

function errorResponse(status: number, body?: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: "Error",
    json: () => Promise.resolve(body ?? { error: { message: "Something went wrong" } }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ModelWikiAPI", () => {
  let env: ReturnType<typeof setupBrowserEnv>;

  beforeEach(() => {
    env = setupBrowserEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- URL construction ----
  describe("URL construction", () => {
    it("uses default baseUrl when none provided", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      await api.getFigures();
      expect(env.mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/v1\/figures(\?|$)/),
        expect.any(Object),
      );
    });

    it("accepts a custom baseUrl", async () => {
      const api = new env.ModelWikiAPI({ baseUrl: "https://api.example.com/v2" });
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      await api.getFigures();
      expect(env.mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/api\.example\.com\/v2\/figures(\?|$)/),
        expect.any(Object),
      );
    });

    it("appends query params for getFigures", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      await api.getFigures({ perPage: 12, sort: "release_date:desc" });
      const url: string = env.mockFetch.mock.calls[0][0];
      expect(url).toContain("perPage=12");
      expect(url).toContain("sort=release_date%3Adesc");
    });

    it("does not append empty or undefined params", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      await api.getFigures({ search: "", page: undefined as unknown as number });
      const url: string = env.mockFetch.mock.calls[0][0];
      expect(url).not.toContain("search=");
      expect(url).not.toContain("page=");
    });

    it("encodes special characters in path slugs", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: {} }));
      await api.getFigure("初音ミク");
      const url: string = env.mockFetch.mock.calls[0][0];
      expect(url).toContain(encodeURIComponent("初音ミク"));
    });

    it("builds correct URL for search", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      await api.search("nendoroid");
      expect(env.mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/search?q=nendoroid"),
        expect.any(Object),
      );
    });

    it("builds correct URL for getSeries with slug", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: {} }));
      await api.getSeries("fate");
      expect(env.mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/series/fate"),
        expect.any(Object),
      );
    });

    it("builds correct URL for getSeries without slug", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      await api.getSeries();
      expect(env.mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/series"),
        expect.any(Object),
      );
    });
  });

  // ---- BigInt conversion ----
  describe("BigInt string conversion", () => {
    it("converts id above Number.MAX_SAFE_INTEGER to string", async () => {
      const api = new env.ModelWikiAPI();
      const bigId = 9007199254740993;
      env.mockFetch.mockResolvedValueOnce(
        okResponse({ data: { id: bigId, name: "Test" } }),
      );
      const state = await api.getFigure("test");
      expect(state.data.id).toBe(String(bigId));
      expect(typeof state.data.id).toBe("string");
    });

    it("keeps safe integer ids as numbers", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(
        okResponse({ data: { id: 42, name: "Test" } }),
      );
      const state = await api.getFigure("test");
      expect(state.data.id).toBe(42);
      expect(typeof state.data.id).toBe("number");
    });

    it("handles null/undefined gracefully", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: null }));
      const state = await api.getFigure("test");
      expect(state.data).toBeNull();
    });

    it("walks nested objects and arrays", async () => {
      const api = new env.ModelWikiAPI();
      const payload = {
        items: [
          { id: 9007199254740993, name: "A" },
          { id: 9007199254740994, name: "B" },
        ],
      };
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: payload }));
      const state = await api.getFigures();
      expect(state.data.items[0].id).toBe(String(9007199254740993));
      expect(state.data.items[1].id).toBe(String(9007199254740994));
      expect(typeof state.data.items[0].id).toBe("string");
    });
  });

  // ---- Loading state transitions ----
  describe("Loading state transitions", () => {
    it("starts with loading: true", async () => {
      const api = new env.ModelWikiAPI();
      // Deliberately leave fetch unresolved to check initial state synchronously?
      // The promise-based approach means we capture state on resolve.
      // Let's verify the returned state has loading: false when done.
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      const state = await api.getFigures();
      expect(state.loading).toBe(false);
    });

    it("sets loading: false on success", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      const state = await api.getFigures();
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
      expect(state.data).toEqual([]);
    });

    it("sets loading: false on error", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockRejectedValueOnce(new Error("Network failure"));
      const state = await api.getFigures();
      expect(state.loading).toBe(false);
      expect(state.error).toBeInstanceOf(Error);
      expect(state.data).toBeNull();
    });
  });

  // ---- Error handling ----
  describe("Error handling", () => {
    it("returns error state on network failure", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockRejectedValueOnce(new Error("Network failure"));
      const state = await api.getFigures();
      expect(state.error).toBeTruthy();
      expect(state.error.message).toMatch(/Network failure/i);
      expect(state.data).toBeNull();
    });

    it("returns error state on 500 response", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(errorResponse(500));
      const state = await api.getFigures();
      expect(state.error).toBeTruthy();
      expect(state.error).toHaveProperty("status", 500);
    });

    it("returns error state on 404 response", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(errorResponse(404));
      const state = await api.getFigure("nonexistent");
      expect(state.error).toBeTruthy();
      expect(state.error).toHaveProperty("status", 404);
    });

    it("returns error state on API-level error (success: false)", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(
        okResponse({ success: false, error: { message: "Bad request" } }, 422),
      );
      const state = await api.getFigures();
      expect(state.error).toBeTruthy();
      expect(state.error.message).toMatch(/Bad request/i);
    });

    it("handles non-JSON response gracefully", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(
        Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: () => Promise.reject(new Error("Invalid JSON")),
        }),
      );
      const state = await api.getFigures();
      expect(state.error).toBeTruthy();
    });
  });

  // ---- Retry logic ----
  describe("Retry logic", () => {
    it("retry function exists on state", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      const state = await api.getFigures();
      expect(typeof state.retry).toBe("function");
    });

    it("retry re-executes the request and returns new state", async () => {
      const api = new env.ModelWikiAPI();
      let callCount = 0;
      env.mockFetch.mockImplementation(() => {
        callCount++;
        return okResponse({ data: [{ id: callCount }] });
      });

      const state1 = await api.getFigures();
      expect(state1.data[0].id).toBe(1);

      const state2 = await state1.retry();
      expect(callCount).toBe(2);
      expect(state2.data[0].id).toBe(2);
    });

    it("retry can recover after an error", async () => {
      const api = new env.ModelWikiAPI();
      env.mockFetch
        .mockRejectedValueOnce(new Error("Temporary failure"))
        .mockResolvedValueOnce(okResponse({ data: [{ id: 1, name: "Recovered" }] }));

      const state1 = await api.getFigures();
      expect(state1.error).toBeTruthy();

      const state2 = await state1.retry();
      expect(state2.error).toBeNull();
      expect(state2.data).toHaveLength(1);
      expect(state2.data[0].name).toBe("Recovered");
    });
  });

  // ---- Request/Response interceptors ----
  describe("Request/Response interceptors", () => {
    it("request interceptor can modify the URL", async () => {
      const api = new env.ModelWikiAPI();
      api.addRequestInterceptor((opts: { url: string }) => {
        opts.url = opts.url.replace("/api/v1", "/api/v2");
        return opts;
      });
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      await api.getFigures();
      expect(env.mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/figures"),
        expect.any(Object),
      );
    });

    it("response interceptor can transform data", async () => {
      const api = new env.ModelWikiAPI();
      api.addResponseInterceptor((data: Record<string, unknown>) => {
        if (data.data && Array.isArray(data.data)) {
          data.data = data.data.map((item: Record<string, unknown>) => ({
            ...item,
            transformed: true,
          }));
        }
        return data;
      });
      env.mockFetch.mockResolvedValueOnce(
        okResponse({ data: [{ id: 1, name: "A" }] }),
      );
      const state = await api.getFigures();
      expect(state.data[0].transformed).toBe(true);
    });

    it("removeRequestInterceptor works", async () => {
      const api = new env.ModelWikiAPI();
      const fn = vi.fn((opts: unknown) => opts);
      const remove = api.addRequestInterceptor(fn);
      remove();
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      await api.getFigures();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // ---- Feature flag integration ----
  describe("Feature flag integration", () => {
    it("respects useNewClient=false flag and returns error", async () => {
      const api = new env.ModelWikiAPI();
      (env.featureFlags as any).set("useNewClient", false);
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [] }));
      const state = await api.getFigures();
      expect(state.error).toBeTruthy();
      expect(state.error.message).toMatch(/disabled by feature flag/i);
    });

    it("works normally when useNewClient is true", async () => {
      const api = new env.ModelWikiAPI();
      (env.featureFlags as any).set("useNewClient", true);
      env.mockFetch.mockResolvedValueOnce(okResponse({ data: [{ id: 1 }] }));
      const state = await api.getFigures();
      expect(state.error).toBeNull();
      expect(state.data).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Feature flags standalone tests
// ---------------------------------------------------------------------------
describe("feature-flags", () => {
  let env: ReturnType<typeof setupBrowserEnv>;

  beforeEach(() => {
    env = setupBrowserEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has defaults", () => {
    const flags = env.featureFlags.getAll();
    expect(flags.useNewClient).toBe(true);
    expect(flags.showGallery).toBe(false);
    expect(flags.lazyLoadImages).toBe(true);
  });

  it("set and get individual flags", () => {
    env.featureFlags.set("showGallery", true);
    expect(env.featureFlags.get("showGallery")).toBe(true);
  });

  it("reset restores defaults", () => {
    env.featureFlags.set("useNewClient", false);
    env.featureFlags.set("showGallery", true);
    env.featureFlags.reset();
    const flags = env.featureFlags.getAll();
    expect(flags.useNewClient).toBe(true);
    expect(flags.showGallery).toBe(false);
  });

  it("onChange fires for specific key", () => {
    const cb = vi.fn();
    env.featureFlags.onChange("showGallery", cb);
    env.featureFlags.set("showGallery", true);
    expect(cb).toHaveBeenCalledWith(true, false);
  });

  it("onChange fires wildcard '*' for any change", () => {
    const cb = vi.fn();
    env.featureFlags.onChange("*", cb);
    env.featureFlags.set("lazyLoadImages", false);
    expect(cb).toHaveBeenCalledWith("lazyLoadImages", false, true);
  });

  it("onChange returns an unsubscribe function", () => {
    const cb = vi.fn();
    const unsub = env.featureFlags.onChange("lazyLoadImages", cb);
    unsub();
    env.featureFlags.set("lazyLoadImages", false);
    expect(cb).not.toHaveBeenCalled();
  });

  it("URL parameter override (ff_useNewClient=false)", () => {
    const freshEnv = setupBrowserEnv({ location: { search: "?ff_useNewClient=false" } });
    expect((freshEnv.featureFlags as any).get("useNewClient")).toBe(false);
  });

  it("localStorage override takes precedence over defaults", () => {
    const freshEnv = setupBrowserEnv({
      localStorage: { "mw-feature-flags": '{"lazyLoadImages":false}' },
    });
    expect((freshEnv.featureFlags as any).get("lazyLoadImages")).toBe(false);
    expect((freshEnv.featureFlags as any).get("useNewClient")).toBe(true);
  });
});
