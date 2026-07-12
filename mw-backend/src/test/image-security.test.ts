import { describe, it, expect } from "vitest";
import { validateImageUrl, isPrivateIPv6 } from "../modules/images/image-security.js";

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

describe("image security — IPv6 blocking", () => {
  it("rejects ::1 loopback URL", async () => {
    const r = await validateImageUrl("http://[::1]:8080/img.jpg");
    expect(r.ok).toBe(false);
  });

  it("isPrivateIPv6 detects loopback", () => {
    expect(isPrivateIPv6("::1")).toBe(true);
  });

  it("isPrivateIPv6 detects ULA fc00::", () => {
    expect(isPrivateIPv6("fc00::1")).toBe(true);
    expect(isPrivateIPv6("fd00::1")).toBe(true);
  });

  it("isPrivateIPv6 detects link-local fe80::", () => {
    expect(isPrivateIPv6("fe80::1")).toBe(true);
  });

  it("isPrivateIPv6 detects IPv4-mapped IPv6 private", () => {
    expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:192.168.1.1")).toBe(true);
  });

  it("isPrivateIPv6 allows public IPv6", () => {
    expect(isPrivateIPv6("2001:db8::1")).toBe(false);
    expect(isPrivateIPv6("2600::1")).toBe(false);
    expect(isPrivateIPv6("2a00::1")).toBe(false);
  });
});
