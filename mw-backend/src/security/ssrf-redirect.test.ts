// Tests for SSRF redirect protection in src/routes/images.ts.
// Run: npx tsx --test src/security/ssrf-redirect.test.ts
//
// These tests verify that every HTTP redirect is re-validated:
//   - Redirects to private/internal IPs (10.x, 192.168.x, 172.16-31.x) are rejected
//   - Redirects to loopback (127.x, ::1) are rejected
//   - Redirects to link-local (169.254.x, metadata IPs) are rejected
//   - DNS rebinding (hostname resolves to both public and private) is rejected
//
// DNS is mocked so tests don't depend on real DNS or network.
// HTTP requests are mocked to simulate redirect responses.

import { test, describe, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import dns from "dns";
import http from "http";
import https from "https";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { validateImageUrl, downloadImage } from "../routes/images.js";

// ─── DNS mock helpers ───────────────────────────────────────────────────────

interface DnsMap {
  [hostname: string]: string[]; // IPv4 addresses
}

let dnsMock: ReturnType<typeof mock.method> | null = null;
let dnsMock6: ReturnType<typeof mock.method> | null = null;

function installDnsMock(map: DnsMap) {
  dnsMock = mock.method(dns.promises, "resolve4", async (hostname: string) => {
    const lower = hostname.toLowerCase();
    if (lower in map) return map[lower];
    throw new Error(`ENOTFOUND: ${hostname}`);
  });
  dnsMock6 = mock.method(dns.promises, "resolve6", async (_hostname: string) => {
    return [];
  });
}

function restoreDnsMock() {
  if (dnsMock) dnsMock.mock.restore();
  if (dnsMock6) dnsMock6.mock.restore();
  dnsMock = null;
  dnsMock6 = null;
}

// ─── HTTP mock helpers ──────────────────────────────────────────────────────
//
// Simulates an HTTP server that returns a redirect response. The mock
// intercepts http.request/https.request and calls the callback with a fake
// response object.

interface HttpMockConfig {
  // First request: return a redirect to this URL
  redirectTo: string;
  // StatusCode for the redirect (default 302)
  statusCode?: number;
}

let httpMock: ReturnType<typeof mock.method> | null = null;
let httpsMock: ReturnType<typeof mock.method> | null = null;

function installHttpRedirectMock(config: HttpMockConfig) {
  const handler = (options: any, callback: (res: any) => void) => {
    // Create a fake response stream
    const res = new PassThrough();
    (res as any).statusCode = config.statusCode ?? 302;
    (res as any).headers = { location: config.redirectTo };
    // Simulate async response
    setImmediate(() => {
      callback(res as any);
      res.end();
    });
    // Return a fake request object
    const req = new EventEmitter() as any;
    req.destroy = () => {};
    req.end = () => {};
    req.on = EventEmitter.prototype.on;
    return req;
  };
  httpMock = mock.method(http, "request", handler as any);
  httpsMock = mock.method(https, "request", handler as any);
}

function restoreHttpMock() {
  if (httpMock) httpMock.mock.restore();
  if (httpsMock) httpsMock.mock.restore();
  httpMock = null;
  httpsMock = null;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("validateImageUrl — DNS resolves to private IP ranges", () => {
  beforeEach(() => restoreDnsMock());
  afterEach(() => restoreDnsMock());

  test("rejects when DNS resolves to 10.0.0.0/8 (private)", async () => {
    installDnsMock({ "evil.example.com": ["10.0.0.5"] });
    const result = await validateImageUrl("http://evil.example.com/image.jpg");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /private/i);
  });

  test("rejects when DNS resolves to 192.168.0.0/16 (private)", async () => {
    installDnsMock({ "evil.example.com": ["192.168.1.1"] });
    const result = await validateImageUrl("http://evil.example.com/image.jpg");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /private/i);
  });

  test("rejects when DNS resolves to 172.16.0.0/12 (private)", async () => {
    installDnsMock({ "evil.example.com": ["172.16.5.5"] });
    const result = await validateImageUrl("http://evil.example.com/image.jpg");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /private/i);
  });

  test("rejects when DNS resolves to 127.0.0.0/8 (loopback)", async () => {
    installDnsMock({ "evil.example.com": ["127.0.0.1"] });
    const result = await validateImageUrl("http://evil.example.com/image.jpg");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /private/i);
  });

  test("rejects when DNS resolves to 169.254.0.0/16 (link-local + metadata)", async () => {
    installDnsMock({ "evil.example.com": ["169.254.169.254"] });
    const result = await validateImageUrl("http://evil.example.com/image.jpg");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /private/i);
  });

  test("rejects when DNS resolves to 100.64.0.0/10 (CGNAT)", async () => {
    installDnsMock({ "evil.example.com": ["100.64.0.1"] });
    const result = await validateImageUrl("http://evil.example.com/image.jpg");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /private/i);
  });

  test("rejects when DNS resolves to 0.0.0.0/8 (this-network)", async () => {
    installDnsMock({ "evil.example.com": ["0.0.0.0"] });
    const result = await validateImageUrl("http://evil.example.com/image.jpg");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /private/i);
  });
});

describe("validateImageUrl — DNS rebinding protection", () => {
  beforeEach(() => restoreDnsMock());
  afterEach(() => restoreDnsMock());

  test("rejects when hostname resolves to BOTH public and private IPs", async () => {
    // DNS rebinding: the hostname resolves to multiple IPs. Even if one is
    // public, the presence of a private IP in the resolution result must
    // cause rejection (fail-closed).
    installDnsMock({
      "rebinding.example.com": ["8.8.8.8", "10.0.0.1"],
    });
    const result = await validateImageUrl("http://rebinding.example.com/image.jpg");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /private/i);
  });

  test("rejects when first IP is public but second is loopback", async () => {
    installDnsMock({
      "rebinding.example.com": ["1.1.1.1", "127.0.0.1"],
    });
    const result = await validateImageUrl("http://rebinding.example.com/image.jpg");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /private/i);
  });

  test("rejects when first IP is public but second is link-local metadata", async () => {
    installDnsMock({
      "rebinding.example.com": ["8.8.4.4", "169.254.169.254"],
    });
    const result = await validateImageUrl("http://rebinding.example.com/image.jpg");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /private/i);
  });

  test("accepts when ALL resolved IPs are public", async () => {
    installDnsMock({
      "safe.example.com": ["8.8.8.8", "1.1.1.1"],
    });
    const result = await validateImageUrl("http://safe.example.com/image.jpg");
    assert.equal(result.ok, true);
  });
});

describe("validateImageUrl — BLOCKED_HOSTS direct check", () => {
  test("rejects 'localhost' without DNS lookup", async () => {
    const result = await validateImageUrl("http://localhost/image.jpg");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "Blocked host");
  });

  test("rejects '127.0.0.1' without DNS lookup", async () => {
    const result = await validateImageUrl("http://127.0.0.1/image.jpg");
    assert.equal(result.ok, false);
  });

  test("rejects '0.0.0.0' without DNS lookup", async () => {
    const result = await validateImageUrl("http://0.0.0.0/image.jpg");
    assert.equal(result.ok, false);
  });

  test("rejects '169.254.169.254' (cloud metadata) without DNS lookup", async () => {
    const result = await validateImageUrl("http://169.254.169.254/latest/meta-data/");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "Blocked host");
  });

  test("rejects 'metadata.google.internal' without DNS lookup", async () => {
    const result = await validateImageUrl("http://metadata.google.internal/computeMetadata/v1/");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "Blocked host");
  });
});

describe("downloadImage — redirect re-validation", () => {
  afterEach(() => {
    restoreDnsMock();
    restoreHttpMock();
  });

  test("rejects redirect to private IP (10.x) — re-validates each hop", async () => {
    // Initial URL resolves to a public IP (passes first validation)
    // HTTP server returns a redirect to evil.example.com
    // evil.example.com resolves to 10.0.0.1 (private) — must be rejected
    installDnsMock({
      "safe.example.com": ["8.8.8.8"],
      "evil.example.com": ["10.0.0.1"],
    });
    installHttpRedirectMock({ redirectTo: "http://evil.example.com/secret.jpg" });

    await assert.rejects(
      () => downloadImage("http://safe.example.com/image.jpg"),
      (err: Error) => {
        assert.match(err.message, /URL validation failed/i);
        return true;
      },
    );
  });

  test("rejects redirect to loopback (127.0.0.1)", async () => {
    installDnsMock({
      "safe.example.com": ["8.8.8.8"],
      "evil.example.com": ["127.0.0.1"],
    });
    installHttpRedirectMock({ redirectTo: "http://evil.example.com/secret.jpg" });

    await assert.rejects(
      () => downloadImage("http://safe.example.com/image.jpg"),
      /URL validation failed/i,
    );
  });

  test("rejects redirect to link-local (169.254.169.254 metadata IP)", async () => {
    installDnsMock({
      "safe.example.com": ["8.8.8.8"],
      "evil.example.com": ["169.254.169.254"],
    });
    installHttpRedirectMock({ redirectTo: "http://evil.example.com/metadata" });

    await assert.rejects(
      () => downloadImage("http://safe.example.com/image.jpg"),
      /URL validation failed/i,
    );
  });

  test("rejects redirect to DNS rebinding target (public + private IPs)", async () => {
    installDnsMock({
      "safe.example.com": ["8.8.8.8"],
      "rebinding.example.com": ["1.1.1.1", "10.0.0.1"],
    });
    installHttpRedirectMock({ redirectTo: "http://rebinding.example.com/x" });

    await assert.rejects(
      () => downloadImage("http://safe.example.com/image.jpg"),
      /URL validation failed/i,
    );
  });

  test("rejects redirect to BLOCKED_HOSTS (localhost)", async () => {
    installDnsMock({
      "safe.example.com": ["8.8.8.8"],
    });
    installHttpRedirectMock({ redirectTo: "http://localhost/secret" });

    await assert.rejects(
      () => downloadImage("http://safe.example.com/image.jpg"),
      /URL validation failed/i,
    );
  });

  test("rejects redirect to BLOCKED_HOSTS (127.0.0.1)", async () => {
    installDnsMock({
      "safe.example.com": ["8.8.8.8"],
    });
    installHttpRedirectMock({ redirectTo: "http://127.0.0.1/secret" });

    await assert.rejects(
      () => downloadImage("http://safe.example.com/image.jpg"),
      /URL validation failed/i,
    );
  });

  test("rejects after too many redirects (MAX_REDIRECTS=5)", async () => {
    installDnsMock({
      "safe.example.com": ["8.8.8.8"],
    });
    // Each redirect points back to the same URL, creating an infinite loop
    installHttpRedirectMock({ redirectTo: "http://safe.example.com/loop" });

    await assert.rejects(
      () => downloadImage("http://safe.example.com/image.jpg"),
      /Too many redirects/i,
    );
  });
});

describe("downloadImage — non-redirect validation", () => {
  afterEach(() => {
    restoreDnsMock();
    restoreHttpMock();
  });

  test("rejects initial URL that resolves to private IP", async () => {
    installDnsMock({ "evil.example.com": ["10.0.0.1"] });
    await assert.rejects(
      () => downloadImage("http://evil.example.com/image.jpg"),
      /URL validation failed/i,
    );
  });

  test("rejects non-http(s) protocols", async () => {
    const result = await validateImageUrl("file:///etc/passwd");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /http/i);
  });

  test("rejects malformed URLs", async () => {
    const result = await validateImageUrl("not-a-url");
    assert.equal(result.ok, false);
  });
});
