import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..", "..");

const php = readFileSync(join(rootDir, "guanli_index.php"), "utf-8");
const adminTs = readFileSync(join(rootDir, "mw-backend", "src", "routes", "admin.ts"), "utf-8");
const reviewsTs = readFileSync(join(rootDir, "mw-backend", "src", "modules", "reviews", "routes.ts"), "utf-8");

const checks = [
  ["guanli keep_pending action string", "keep_pending", php],
  ["reviews.ts decisionReason field", "decisionReason", reviewsTs],
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

// Extract JS from script tag — avoids mangling SVG-in-string-literals
const scriptMatch = php.match(/<script>([\s\S]*?)<\/script>/g);
if (scriptMatch) {
  let allJs = scriptMatch.map(block => {
    const inner = block.replace(/<script>/, "").replace(/<\/script>/, "");
    return inner;
  }).join("\n");

  // Strip PHP short tags and HTML that survived the script tag extraction
  allJs = allJs.replace(/<\?php[\s\S]*?\?>/g, "");

  if (allJs.trim().length > 100) {
    const tmp = join(tmpdir(), `admin-js-syntax-${Date.now()}.js`);
    writeFileSync(tmp, allJs, "utf-8");
    try {
      execSync(`node --check "${tmp}"`, { stdio: "pipe", encoding: "utf-8", timeout: 10000 });
      console.log("PASS: admin JS syntax check (script-tag extraction)");
    } catch (e) {
      const stderr = e.stderr || "";
      const syntaxErrorLine = (stderr.split("\n").filter(l => l.includes("SyntaxError"))[0] || "").trim();
      console.log(`FAIL: admin JS syntax check — ${syntaxErrorLine || "SyntaxError in extracted JS"}`);
      allOk = false;
    }
    try { unlinkSync(tmp); } catch {}
  } else {
    console.log("SKIP: JS syntax check (extracted JS too short)");
  }
} else {
  console.log("SKIP: JS syntax check (no <script> block found)");
}

console.log(allOk ? "admin-js-check: ALL PASS" : "admin-js-check: FAILED");
process.exit(allOk ? 0 : 1);
