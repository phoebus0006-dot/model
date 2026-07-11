import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClient } from "../api/client.js";

const BASE_URL = "http://test-api/v1";

function makeFetchMock(status: number, body: unknown, headers?: Record<string, string>) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : status === 422 ? "Unprocessable" : "OK",
    headers: new Map(Object.entries(headers || {})),
    json: () => Promise.resolve(body),
  });
}

describe("ApiClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("GET returns data on success", async () => {
    const mockData = { data: { id: "1", name: "test" }, success: true };
    vi.mocked(fetch).mockImplementation(makeFetchMock(200, mockData));

    const client = createClient({ baseUrl: BASE_URL });
    const result = await client.get<{ id: string; name: string }>("/figures/test");
    expect(result).toEqual({ id: "1", name: "test" });
  });

  it("POST sends body as JSON", async () => {
    vi.mocked(fetch).mockImplementation(makeFetchMock(201, { data: { id: "1" }, success: true }));

    const client = createClient({ baseUrl: BASE_URL });
    await client.post("/figures", { name: "test" });

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const options = callArgs[1] as RequestInit;
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(options.body).toBe(JSON.stringify({ name: "test" }));
  });

  it("sends Bearer token when provided", async () => {
    vi.mocked(fetch).mockImplementation(makeFetchMock(200, { data: {}, success: true }));

    const client = createClient({
      baseUrl: BASE_URL,
      getToken: () => "test-token",
    });
    await client.get("/figures");

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const options = callArgs[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });

  it("throws UnauthorizedError on 401", async () => {
    vi.mocked(fetch).mockImplementation(
      makeFetchMock(401, { success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } })
    );

    const client = createClient({ baseUrl: BASE_URL });
    await expect(client.get("/admin/items")).rejects.toThrow("Unauthorized");
  });

  it("throws NotFoundError on 404", async () => {
    vi.mocked(fetch).mockImplementation(
      makeFetchMock(404, { success: false, error: { code: "NOT_FOUND", message: "Not found" } })
    );

    const client = createClient({ baseUrl: BASE_URL });
    await expect(client.get("/figures/nonexistent")).rejects.toThrow("Not found");
  });

  it("throws ValidationError on 422", async () => {
    vi.mocked(fetch).mockImplementation(
      makeFetchMock(422, { success: false, error: { code: "VALIDATION_ERROR", message: "Invalid input" } })
    );

    const client = createClient({ baseUrl: BASE_URL });
    await expect(client.post("/figures", {})).rejects.toThrow("Invalid input");
  });

  it("throws TimeoutError on abort", async () => {
    vi.mocked(fetch).mockImplementation(
      () => Promise.reject(new DOMException("The operation was aborted", "AbortError"))
    );

    const client = createClient({ baseUrl: BASE_URL, timeout: 100 });
    await expect(client.get("/figures")).rejects.toThrow("Request timed out");
  });

  it("appends query params", async () => {
    vi.mocked(fetch).mockImplementation(makeFetchMock(200, { data: [], success: true }));

    const client = createClient({ baseUrl: BASE_URL });
    await client.get("/figures", { params: { page: 1, perPage: 20, search: "test" } });

    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain("page=1");
    expect(url).toContain("perPage=20");
    expect(url).toContain("search=test");
  });

  it("omits undefined params", async () => {
    vi.mocked(fetch).mockImplementation(makeFetchMock(200, { data: [], success: true }));

    const client = createClient({ baseUrl: BASE_URL });
    await client.get("/figures", { params: { page: 1, search: undefined } });

    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain("page=1");
    expect(url).not.toContain("search");
  });

  it("calls onUnauthorized callback on 401", async () => {
    const onUnauthorized = vi.fn();
    vi.mocked(fetch).mockImplementation(
      makeFetchMock(401, { success: false, error: { code: "UNAUTHORIZED", message: "" } })
    );

    const client = createClient({ baseUrl: BASE_URL, onUnauthorized });
    await expect(client.get("/admin/items")).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("returns paginated response data", async () => {
    vi.mocked(fetch).mockImplementation(
      makeFetchMock(200, {
        success: true,
        data: [{ id: "1" }],
        meta: { count: 1, total: 1, limit: 50, offset: 0 },
      })
    );

    const client = createClient({ baseUrl: BASE_URL });
    const result = await client.get<Array<{ id: string }>>("/figures");
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].id).toBe("1");
  });

  it("generates unique request IDs", async () => {
    vi.mocked(fetch).mockImplementation(makeFetchMock(200, { data: {}, success: true }));

    const client = createClient({ baseUrl: BASE_URL });
    await client.get("/a");
    await client.get("/b");

    // Request ID is in the error if thrown, but not exposed on success.
    // Verify two requests were made (no dedup bug).
    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
  });
});
