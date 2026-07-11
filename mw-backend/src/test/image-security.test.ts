import { describe, it, expect } from "vitest";
import { validateImageUrl } from "../modules/images/image-security.js";

describe("image security — URL validation", () => {
  it("allows https URL", async () => {
    const r = await validateImageUrl("https://example.com/img.jpg");
    expect(r.ok).toBe(true);
  });

  it("allows http URL", async () => {
    const r = await validateImageUrl("http://example.com/img.jpg");
    expect(r.ok).toBe(true);
  });

  it("rejects ftp URL", async () => {
    const r = await validateImageUrl("ftp://example.com/img.jpg");
    expect(r.ok).toBe(false);
  });

  it("rejects localhost", async () => {
    const r = await validateImageUrl("http://localhost:8080/img.jpg");
    expect(r.ok).toBe(false);
  });

  it("rejects 127.0.0.1", async () => {
    const r = await validateImageUrl("http://127.0.0.1/img.jpg");
    expect(r.ok).toBe(false);
  });

  it("rejects 0.0.0.0", async () => {
    const r = await validateImageUrl("http://0.0.0.0/img.jpg");
    expect(r.ok).toBe(false);
  });

  it("rejects private IP 10.x.x.x", async () => {
    const r = await validateImageUrl("http://10.0.0.1/img.jpg");
    expect(r.ok).toBe(false);
  });

  it("rejects private IP 192.168.x.x", async () => {
    const r = await validateImageUrl("http://192.168.1.1/img.jpg");
    expect(r.ok).toBe(false);
  });

  it("rejects private IP 172.16.x.x", async () => {
    const r = await validateImageUrl("http://172.16.0.1/img.jpg");
    expect(r.ok).toBe(false);
  });

  it("rejects metadata IP 169.254.169.254", async () => {
    const r = await validateImageUrl("http://169.254.169.254/img.jpg");
    expect(r.ok).toBe(false);
  });

  it("rejects GCP metadata hostname", async () => {
    const r = await validateImageUrl("http://metadata.google.internal/img.jpg");
    expect(r.ok).toBe(false);
  });

  it("rejects malformed URL", async () => {
    const r = await validateImageUrl("not-a-url");
    expect(r.ok).toBe(false);
  });

  it("rejects empty URL", async () => {
    const r = await validateImageUrl("");
    expect(r.ok).toBe(false);
  });

  it("rejects URL without protocol", async () => {
    const r = await validateImageUrl("//evil.com/img.jpg");
    expect(r.ok).toBe(false);
  });
});
