// Tests for SSRF hardening in src/routes/images.ts — Phase 1+2 runtime-security.
// Run: npx tsx --test src/security/ssrf.test.ts
//
// These tests cover the isPrivateIp() function which is the core SSRF defense.
// They do NOT require a live DNS or Redis instance — isPrivateIp is a pure
// function. End-to-end SSRF tests via validateImageUrl require DNS mocking
// and are a carry-over item for the storage-level integration test suite.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp } from "../routes/images.js";

describe("isPrivateIp — IPv4 private ranges", () => {
  test("10.0.0.0/8 (private class A)", () => {
    assert.equal(isPrivateIp("10.0.0.1"), true);
    assert.equal(isPrivateIp("10.255.255.255"), true);
    assert.equal(isPrivateIp("10.1.2.3"), true);
  });

  test("172.16.0.0/12 (private)", () => {
    assert.equal(isPrivateIp("172.16.0.1"), true);
    assert.equal(isPrivateIp("172.31.255.255"), true);
    assert.equal(isPrivateIp("172.20.30.40"), true);
  });

  test("172.15.x and 172.32.x are NOT private (boundary check)", () => {
    assert.equal(isPrivateIp("172.15.0.1"), false);
    assert.equal(isPrivateIp("172.32.0.1"), false);
  });

  test("192.168.0.0/16 (private)", () => {
    assert.equal(isPrivateIp("192.168.1.1"), true);
    assert.equal(isPrivateIp("192.168.0.0"), true);
    assert.equal(isPrivateIp("192.168.255.255"), true);
  });

  test("100.64.0.0/10 (CGNAT)", () => {
    assert.equal(isPrivateIp("100.64.0.1"), true);
    assert.equal(isPrivateIp("100.127.255.255"), true);
    assert.equal(isPrivateIp("100.100.100.100"), true);
  });

  test("100.63.x and 100.128.x are NOT CGNAT (boundary check)", () => {
    assert.equal(isPrivateIp("100.63.0.1"), false);
    assert.equal(isPrivateIp("100.128.0.1"), false);
  });

  test("0.0.0.0/8 (this-network)", () => {
    assert.equal(isPrivateIp("0.0.0.0"), true);
    assert.equal(isPrivateIp("0.1.2.3"), true);
  });

  test("127.0.0.0/8 (loopback)", () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
    assert.equal(isPrivateIp("127.255.255.255"), true);
    assert.equal(isPrivateIp("127.1.2.3"), true);
  });

  test("169.254.0.0/16 (link-local + cloud metadata) — Phase 1+2 hardening", () => {
    // This is the key fix: previously only 169.254.169.254 was in BLOCKED_HOSTS,
    // but the rest of 169.254.0.0/16 was NOT blocked. Now the whole range is.
    assert.equal(isPrivateIp("169.254.169.254"), true);  // AWS/GCP metadata
    assert.equal(isPrivateIp("169.254.0.1"), true);
    assert.equal(isPrivateIp("169.254.255.255"), true);
    assert.equal(isPrivateIp("169.254.100.50"), true);
  });

  test("169.253.x and 169.255.x are NOT link-local (boundary check)", () => {
    assert.equal(isPrivateIp("169.253.0.1"), false);
    assert.equal(isPrivateIp("169.255.0.1"), false);
  });

  test("224.0.0.0/4+ (multicast + reserved)", () => {
    assert.equal(isPrivateIp("224.0.0.1"), true);
    assert.equal(isPrivateIp("239.255.255.255"), true);
    assert.equal(isPrivateIp("255.255.255.255"), true);
  });

  test("public IPs are NOT private", () => {
    assert.equal(isPrivateIp("1.1.1.1"), false);
    assert.equal(isPrivateIp("8.8.8.8"), false);
    assert.equal(isPrivateIp("141.253.114.69"), false);
    assert.equal(isPrivateIp("47.103.142.71"), false);
    assert.equal(isPrivateIp("115.190.6.185"), false);
  });
});

describe("isPrivateIp — IPv6 special addresses", () => {
  test("::1 (loopback)", () => {
    assert.equal(isPrivateIp("::1"), true);
    assert.equal(isPrivateIp("0:0:0:0:0:0:0:1"), true);
  });

  test(":: (unspecified) — Phase 1+2 hardening", () => {
    assert.equal(isPrivateIp("::"), true);
    assert.equal(isPrivateIp("0:0:0:0:0:0:0:0"), true);
  });

  test("fc00::/7 (ULA)", () => {
    assert.equal(isPrivateIp("fc00::1"), true);
    assert.equal(isPrivateIp("fd00::1"), true);
    assert.equal(isPrivateIp("fd12:3456:789a::1"), true);
    assert.equal(isPrivateIp("fcff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), true);
  });

  test("fe80::/10 (link-local) — Phase 1+2 hardening (full range)", () => {
    assert.equal(isPrivateIp("fe80::1"), true);
    assert.equal(isPrivateIp("fe80::"), true);
    assert.equal(isPrivateIp("FE80::1"), true);
    // fe9x, feax, febx are also in fe80::/10 — previously NOT caught
    assert.equal(isPrivateIp("fe90::1"), true);
    assert.equal(isPrivateIp("fea0::1"), true);
    assert.equal(isPrivateIp("feb0::1"), true);
    assert.equal(isPrivateIp("febF:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), true);
  });

  test("fec0::/10 are NOT link-local (boundary check)", () => {
    // fec0::/10 was deprecated site-local; now reserved. Not in fe80::/10.
    assert.equal(isPrivateIp("fec0::1"), false);
    assert.equal(isPrivateIp("feff::1"), false);
  });

  test("ff00::/8 (multicast)", () => {
    assert.equal(isPrivateIp("ff00::1"), true);
    assert.equal(isPrivateIp("ff02::1"), true);
    assert.equal(isPrivateIp("FF02::1"), true);
    assert.equal(isPrivateIp("ffee::1234"), true);
  });
});

describe("isPrivateIp — IPv4-mapped IPv6", () => {
  test("dotted-decimal form (::ffff:10.0.0.1)", () => {
    assert.equal(isPrivateIp("::ffff:10.0.0.1"), true);
    assert.equal(isPrivateIp("::ffff:192.168.1.1"), true);
    assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateIp("::ffff:169.254.169.254"), true);
    assert.equal(isPrivateIp("::FFFF:10.0.0.1"), true); // uppercase
  });

  test("dotted-decimal form with public IPv4", () => {
    assert.equal(isPrivateIp("::ffff:1.1.1.1"), false);
    assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
  });

  test("hex form (::ffff:0a:00:01) — Phase 1+2 hardening", () => {
    // Previously only the dotted-decimal form was parsed. An attacker could
    // bypass SSRF checks by using the hex form. Now both forms are caught.
    // 0a.00.00.01 = 10.0.0.1
    assert.equal(isPrivateIp("::ffff:0a00:0001"), true);
    // c0a8:0101 = 192.168.1.1
    assert.equal(isPrivateIp("::ffff:c0a8:0101"), true);
    // 7f00:0001 = 127.0.0.1
    assert.equal(isPrivateIp("::ffff:7f00:0001"), true);
    // a9fe:a9fe = 169.254.169.254
    assert.equal(isPrivateIp("::ffff:a9fe:a9fe"), true);
    // uppercase hex
    assert.equal(isPrivateIp("::FFFF:0A00:0001"), true);
  });

  test("hex form with public IPv4", () => {
    // 0101:0101 = 1.1.1.1
    assert.equal(isPrivateIp("::ffff:0101:0101"), false);
    // 0808:0808 = 8.8.8.8
    assert.equal(isPrivateIp("::ffff:0808:0808"), false);
  });
});

describe("isPrivateIp — edge cases", () => {
  test("empty/null/undefined input returns false (no throw)", () => {
    assert.equal(isPrivateIp(""), false);
    assert.equal(isPrivateIp(null as any), false);
    assert.equal(isPrivateIp(undefined as any), false);
  });

  test("garbage strings do not throw (returns false or true=fail-closed)", () => {
    // Truly non-IP garbage returns false
    assert.equal(isPrivateIp("not-an-ip"), false);
    assert.equal(isPrivateIp(":::123"), false);
    // "999.999.999.999" parses as 4 numeric parts with parts[0]=999 >= 224,
    // so it is treated as reserved and blocked (fail-closed). This is safe
    // behavior — invalid octets >= 224 should not be allowed.
    assert.equal(isPrivateIp("999.999.999.999"), true);
  });
});
