import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = process.argv.includes("--rootDir")
  ? process.argv[process.argv.indexOf("--rootDir") + 1]
  : join(__dirname, "..", "..");

const adminJsPath = join(rootDir, "modelwiki-theme", "assets", "js", "admin.js");
let adminJs = "";
try {
  adminJs = readFileSync(adminJsPath, "utf-8");
} catch (e) {
  console.log(`FAIL: Could not read admin.js at ${adminJsPath}`);
}
const adminTs = readFileSync(join(rootDir, "mw-backend", "src", "routes", "admin.ts"), "utf-8");
const reviewsTs = readFileSync(join(rootDir, "mw-backend", "src", "modules", "reviews", "routes.ts"), "utf-8");

const checks = [
  ["admin.js keep_pending action string", "keep_pending", adminJs],
  ["reviews.ts decisionReason field", "decisionReason", reviewsTs],
];
let allOk = true;
for (const [name, pattern, content] of checks) {
  if (content && content.includes(pattern)) {
    console.log(`PASS: "${name}"`);
  } else {
    console.log(`FAIL: "${name}" — pattern "${pattern}" not found`);
    allOk = false;
  }
}

if (adminJs) {
  try {
    execSync(`node --check "${adminJsPath}"`, { stdio: "pipe", encoding: "utf-8", timeout: 10000 });
    console.log("PASS: admin JS syntax check (node --check)");
  } catch (e) {
    const stderr = e.stderr || "";
    const syntaxErrorLine = (stderr.split("\n").filter(l => l.includes("SyntaxError"))[0] || "").trim();
    console.log(`FAIL: admin JS syntax check — ${syntaxErrorLine || "SyntaxError in admin.js"}`);
    allOk = false;
  }
}

console.log(allOk ? "admin-js-check: ALL PASS" : "admin-js-check: FAILED");
process.exit(allOk ? 0 : 1);
