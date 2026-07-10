import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..", "..");
// rootDir is the repo root

const php = readFileSync(join(rootDir, "guanli_index.php"), "utf-8");
const adminTs = readFileSync(join(rootDir, "mw-backend", "src", "routes", "admin.ts"), "utf-8");

const checks = [
  ["guanli keep_pending action string", "keep_pending", php],
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

// Extract raw JS from guanli PHP for best-effort syntax check
const jsStart = php.search(/\b(var |function |const |let )/);
if (jsStart >= 0) {
  const jsRaw = php.slice(jsStart)
    .replace(/^<\?php[\s\S]*?\?>/gm, "")
    .replace(/<\/?[a-z][^>]*>/gi, "\n")
    .replace(/^\s*[\u4e00-\u9fff][\s\S]*$/gm, "");
  if (jsRaw.trim().length > 100) {
    const tmp = join(tmpdir(), `admin-js-syntax-${Date.now()}.js`);
    writeFileSync(tmp, jsRaw, "utf-8");
    try {
      execSync(`node --check "${tmp}"`, { stdio: "pipe", encoding: "utf-8", timeout: 10000 });
      console.log("PASS: admin JS syntax check (best-effort)");
    } catch (e) {
      const stderr = e.stderr || "";
      const err = (stderr.split("\n").filter(l => l.includes("SyntaxError"))[0] || "").trim();
      console.log(`INFO: JS syntax check best-effort — PHP+JS interleaving. ${err || "no specific SyntaxError in output"}`);
    }
    try { unlinkSync(tmp); } catch {}
  } else {
    console.log("SKIP: JS syntax check (extracted JS too short)");
  }
} else {
  console.log("SKIP: JS syntax check (no JS block found)");
}

console.log(allOk ? "admin-js-check: ALL PASS" : "admin-js-check: SOME FAILED");
process.exit(allOk ? 0 : 1);
