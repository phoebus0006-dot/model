import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const SCRIPT = join(__dirname, "..", "..", "scripts", "admin-js-check.mjs");
const PHP_PATH = "D:\\model wiki\\guanli_index.php";

describe("admin-js-check", () => {
  it("exits 0 and prints ALL PASS with real files", () => {
    const result = execSync(`node "${SCRIPT}"`, { encoding: "utf-8", timeout: 15000 });
    expect(result).toContain("ALL PASS");
  });

  it("detects missing keep_pending in PHP", () => {
    const php = readFileSync(PHP_PATH, "utf-8");
    expect(php).toContain("keep_pending");
  });

  it("detects missing decisionReason in reviews routes", () => {
    const routes = readFileSync(join(__dirname, "..", "modules", "reviews", "routes.ts"), "utf-8");
    expect(routes).toContain("decisionReason");
  });
});
