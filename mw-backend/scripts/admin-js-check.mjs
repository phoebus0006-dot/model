import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..", "..");
// rootDir is the repo root

// Phase 1+2: support both legacy guanli_index.php and canonical modelwiki-theme/page-guanli.php
const candidatePaths = [
  join(rootDir, "modelwiki-theme", "page-guanli.php"),
  join(rootDir, "guanli_index.php"),
];
const phpPath = candidatePaths.find((p) => existsSync(p));
if (!phpPath) {
  console.error("FAIL: no guanli PHP file found (looked for: " + candidatePaths.join(", ") + ")");
  process.exit(1);
}
const php = readFileSync(phpPath, "utf-8");
const adminTs = readFileSync(join(rootDir, "mw-backend", "src", "routes", "admin.ts"), "utf-8");

const checks = [
  ["guanli keep_pending action string", "keep_pending", php],
  ["guanli reviewActionName helper (Phase 1+2)", "reviewActionName", php],
  ["admin.ts decisionReason field", "decisionReason", adminTs],
];
let allOk = true;
for (const [name, pattern, content] of checks) {
  if (content.includes(pattern)) {
    console.log(`PASS: "${name}"`);
  } else {
    console.log(`FAIL: "${name}" — pattern "${pattern}" not found`);
    allOk = false;
  }
}

// Extract every <script>...</script> block from the PHP file and syntax-check each.
// This is stricter than the previous best-effort whole-file extraction and matches
// the admin-js gate used in Phase 1+2 contract §16.
const scriptBlockRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
let blockIdx = 0;
let blockOk = 0;
let blockBad = 0;
let m;
while ((m = scriptBlockRe.exec(php)) !== null) {
  blockIdx++;
  const code = m[1];
  if (!code.trim()) continue;
  const tmp = join(tmpdir(), `admin-js-block-${blockIdx}-${Date.now()}.js`);
  writeFileSync(tmp, code, "utf-8");
  try {
    execSync(`node --check "${tmp}"`, { stdio: "pipe", encoding: "utf-8", timeout: 10000 });
    blockOk++;
  } catch (e) {
    blockBad++;
    const stderr = e.stderr || "";
    const errLine = (stderr.split("\n").filter(l => l.includes("SyntaxError"))[0] || "").trim();
    console.log(`FAIL: admin JS block #${blockIdx} syntax error: ${errLine || e.message}`);
    allOk = false;
  }
  try { unlinkSync(tmp); } catch {}
}
console.log(`admin-js blocks: ${blockOk} ok, ${blockBad} bad`);

console.log(allOk ? "admin-js-check: ALL PASS" : "admin-js-check: SOME FAILED");
process.exit(allOk ? 0 : 1);
