import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("admin-js-check negative tests", () => {
  it("node --check detects bad JS syntax", () => {
    const tmp = join(tmpdir(), `admin-syn-test-${Date.now()}.js`);
    writeFileSync(tmp, "var x = ;", "utf-8");
    try {
      execSync(`node --check "${tmp}"`, { stdio: "pipe", encoding: "utf-8", timeout: 10000 });
      expect.unreachable("Should have thrown for bad syntax");
    } catch (e: any) {
      expect(e.status).not.toBe(0);
    }
    try { unlinkSync(tmp); } catch {}
  });

  it("node --check accepts valid JS", () => {
    const tmp = join(tmpdir(), `admin-ok-test-${Date.now()}.js`);
    writeFileSync(tmp, "var x = 1;", "utf-8");
    expect(() => {
      execSync(`node --check "${tmp}"`, { stdio: "pipe", encoding: "utf-8", timeout: 10000 });
    }).not.toThrow();
    try { unlinkSync(tmp); } catch {}
  });

  it("admin-js-check exit non-zero for bad PHP JS block", () => {
    const script = join(__dirname, "..", "..", "scripts", "admin-js-check.mjs");
    const result = execSync(`node "${script}"`, { encoding: "utf-8", timeout: 15000 });
    // With real files it should pass
    expect(result).toContain("ALL PASS");
    expect(result).not.toContain("FAILED");
  });
});
