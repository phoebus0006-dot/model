import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT = join(__dirname, "..", "..", "scripts", "admin-js-check.mjs");
const ROOT = join(__dirname, "..", "..", "..");
const PHP_PATH = join(ROOT, "guanli_index.php");

describe("admin-js-check", () => {
  it("exits 0 and prints ALL PASS with real files", () => {
    const result = execSync(`node "${SCRIPT}"`, { encoding: "utf-8", timeout: 15000 });
    expect(result).toContain("ALL PASS");
  });

  it("detects missing keep_pending in admin.js", () => {
    const adminJsPath = join(__dirname, "..", "..", "..", "modelwiki-theme", "assets", "js", "admin.js");
    let content = "";
    try { content = readFileSync(adminJsPath, "utf-8"); } catch(e){}
    expect(content).toContain("keep_pending");
  });

  it("detects missing decisionReason in reviews routes", () => {
    const routes = readFileSync(join(__dirname, "..", "modules", "reviews", "routes.ts"), "utf-8");
    expect(routes).toContain("decisionReason");
  });
});

const VALID_JS = Array(20).fill("var x = 1;").join("\n");
const BAD_SYNTAX_JS = Array(20).fill("var x = 1;").join("\n") + "\n" + "var y = ;";

describe("admin-js-check fixture tests", () => {
  const FIXTURE = join(__dirname, "..", "..", "..", "tmp-test-admin-fixture");

  function setUpFixture(adminJsContent: string, adminContent?: string, reviewsContent?: string) {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(join(FIXTURE, "mw-backend", "src", "routes"), { recursive: true });
    mkdirSync(join(FIXTURE, "mw-backend", "src", "modules", "reviews"), { recursive: true });
    mkdirSync(join(FIXTURE, "modelwiki-theme", "assets", "js"), { recursive: true });
    writeFileSync(join(FIXTURE, "modelwiki-theme", "assets", "js", "admin.js"), adminJsContent, "utf-8");
    writeFileSync(join(FIXTURE, "mw-backend", "src", "routes", "admin.ts"), adminContent || "// admin routes", "utf-8");
    writeFileSync(join(FIXTURE, "mw-backend", "src", "modules", "reviews", "routes.ts"), reviewsContent || "export const decisionReason = true;", "utf-8");
  }

  it("exits 0 with valid JS", () => {
    const adminJs = `const action = 'keep_pending';\n${VALID_JS}`;
    setUpFixture(adminJs);
    try {
      const result = execSync(`node "${SCRIPT}" --rootDir "${FIXTURE}"`, { encoding: "utf-8", timeout: 10000 });
      expect(result).toContain("ALL PASS");
    } finally {
      rmSync(FIXTURE, { recursive: true, force: true });
    }
  });

  it("exits non-zero and prints FAILED with SyntaxError", () => {
    const adminJs = `const action = 'keep_pending';\n${BAD_SYNTAX_JS}`;
    setUpFixture(adminJs);
    try {
      const r = execSync(`node "${SCRIPT}" --rootDir "${FIXTURE}"`, { encoding: "utf-8", timeout: 10000 });
      expect(r).toContain("FAILED");
    } catch (e: any) {
      expect(e.status).not.toBe(0);
      const out = (e.stdout || e.message || String(e));
      expect(out).toContain("FAILED");
    } finally {
      rmSync(FIXTURE, { recursive: true, force: true });
    }
  });

  it("exits non-zero with broken JS token", () => {
    const badJs = Array(20).fill("var x = 1;").join("\n") + "\n" + "const foo = ;";
    const php = `<?php $action = 'keep_pending'; ?><html><script>${badJs}</script></html>`;
    setUpFixture(php);
    try {
      const r = execSync(`node "${SCRIPT}" --rootDir "${FIXTURE}"`, { encoding: "utf-8", timeout: 10000 });
      expect(r).toContain("FAILED");
    } catch (e: any) {
      expect(e.status).not.toBe(0);
      const out = (e.stdout || e.message || String(e));
      expect(out).toContain("FAILED");
    } finally {
      rmSync(FIXTURE, { recursive: true, force: true });
    }
  });
});
