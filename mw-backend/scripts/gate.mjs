// Phase 1+2 unified QA gate — runs all gates from contract §16.
// Usage: node scripts/gate.mjs
//
// Gates (each prints PASS/FAIL/SKIP and contributes to overall exit code):
//   1. prisma validate        — schema validation (requires DATABASE_URL env or .env)
//   2. typecheck              — tsc --noEmit
//   3. backend build          — tsup src/index.ts --format cjs
//   4. backend tests          — tsx --test on all *.test.ts under src/
//   5. admin JS check         — scripts/admin-js-check.mjs
//   6. PHP syntax check       — php -l on every *.php under modelwiki-theme/ (SKIP if php not installed)
//   7. Python tests           — python -m pytest (SKIP if no pytest or no tests/)
//   8. secret scan            — regex scan for AWS keys, GitHub PATs, private keys, hard-coded passwords

import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backendDir = join(__dirname, "..");
const repoRoot = join(__dirname, "..", "..");

const results = []; // { name, status: "PASS"|"FAIL"|"SKIP", detail }
let overallOk = true;

function run(name, fn) {
  try {
    const detail = fn();
    results.push({ name, status: "PASS", detail: detail || "" });
    console.log(`PASS: ${name}${detail ? " — " + detail : ""}`);
  } catch (e) {
    const detail = (e.message || String(e)).slice(0, 200);
    const isSkip = e.skip === true;
    if (isSkip) {
      results.push({ name, status: "SKIP", detail });
      console.log(`SKIP: ${name} — ${detail}`);
    } else {
      results.push({ name, status: "FAIL", detail });
      console.log(`FAIL: ${name} — ${detail}`);
      overallOk = false;
    }
  }
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { cwd: backendDir, encoding: "utf-8", timeout: 120000, stdio: "pipe", ...opts });
}

function hasBin(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: "pipe", encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

class SkipError extends Error {
  constructor(msg) { super(msg); this.skip = true; }
}

// ─── Gate 1: prisma validate ─────────────────────────────────────────────────
run("prisma validate", () => {
  if (!existsSync(join(backendDir, "prisma", "schema.prisma"))) {
    throw new SkipError("prisma/schema.prisma not found");
  }
  // prisma validate requires DATABASE_URL to be set (even a placeholder works)
  const env = { ...process.env };
  if (!env.DATABASE_URL) env.DATABASE_URL = "postgresql://placeholder:placeholder@localhost:5432/placeholder";
  try {
    const out = exec("npx prisma validate", { env });
    const last = out.trim().split("\n").pop();
    return last;
  } catch (e) {
    throw new Error((e.stderr || e.stdout || e.message).slice(0, 200));
  }
});

// ─── Gate 2: TypeScript typecheck ────────────────────────────────────────────
run("typecheck", () => {
  try {
    exec("npx tsc --noEmit");
    return "tsc: no errors";
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    // Filter to first few meaningful lines
    const lines = out.split("\n").filter(l => l.trim() && !l.startsWith("node:")).slice(0, 5);
    throw new Error(lines.join(" | ").slice(0, 200));
  }
});

// ─── Gate 3: backend build ───────────────────────────────────────────────────
run("backend build", () => {
  try {
    const out = exec("npx tsup src/index.ts --format cjs --no-sourcemap");
    const ok = out.includes("Build success") || out.includes("Build done");
    if (!ok) throw new Error(out.slice(-200));
    const m = out.match(/(\d+(?:\.\d+)?)\s*KB/);
    return m ? `dist ${m[1]} KB` : "build ok";
  } catch (e) {
    throw new Error((e.stdout || e.stderr || e.message).slice(0, 200));
  }
});

// ─── Gate 4: backend tests ───────────────────────────────────────────────────
run("backend tests", () => {
  // Discover test files under src/
  function findTests(dir, acc = []) {
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      const st = statSync(full);
      if (st.isDirectory()) findTests(full, acc);
      else if (ent.endsWith(".test.ts")) acc.push(full);
    }
    return acc;
  }
  const testFiles = findTests(join(backendDir, "src"));
  if (testFiles.length === 0) throw new SkipError("no *.test.ts files under src/");
  const rel = testFiles.map(f => relative(backendDir, f).replace(/\\/g, "/"));
  try {
    const out = exec(`npx tsx --test ${rel.join(" ")}`);
    const m = out.match(/ℹ tests\s+(\d+)[\s\S]*?ℹ pass\s+(\d+)[\s\S]*?ℹ fail\s+(\d+)/);
    if (m) {
      const total = +m[1], pass = +m[2], fail = +m[3];
      if (fail > 0) throw new Error(`${fail}/${total} tests failed`);
      return `${pass}/${total} tests pass`;
    }
    // Fallback: look for exit code 0
    return `${testFiles.length} test files ran`;
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    const failLine = out.split("\n").find(l => l.includes("ℹ fail")) || "";
    throw new Error(failLine.trim() || out.slice(0, 200));
  }
});

// ─── Gate 5: admin JS check ──────────────────────────────────────────────────
run("admin JS check", () => {
  try {
    const out = exec("node scripts/admin-js-check.mjs");
    if (out.includes("ALL PASS")) return "admin-js: ALL PASS";
    throw new Error(out.split("\n").filter(l => l.includes("FAIL")).join(" | ").slice(0, 200) || "admin-js check failed");
  } catch (e) {
    throw new Error((e.stdout || e.stderr || e.message).slice(0, 200));
  }
});

// ─── Gate 6: PHP syntax check ────────────────────────────────────────────────
run("PHP syntax check", () => {
  if (!hasBin("php")) throw new SkipError("php CLI not installed locally");
  const themeDir = join(repoRoot, "modelwiki-theme");
  if (!existsSync(themeDir)) throw new SkipError("modelwiki-theme/ not found");
  const phpFiles = [];
  function findPhp(dir) {
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      const st = statSync(full);
      if (st.isDirectory()) findPhp(full);
      else if (ent.endsWith(".php")) phpFiles.push(full);
    }
  }
  findPhp(themeDir);
  // Also check root-level guanli_index.php if present
  const rootGuanli = join(repoRoot, "guanli_index.php");
  if (existsSync(rootGuanli)) phpFiles.push(rootGuanli);
  if (phpFiles.length === 0) throw new SkipError("no *.php files found");
  let bad = 0;
  const errors = [];
  for (const f of phpFiles) {
    try {
      execSync(`php -l "${f}"`, { stdio: "pipe", encoding: "utf-8", timeout: 10000 });
    } catch (e) {
      bad++;
      const out = (e.stdout || "") + (e.stderr || "");
      const line = out.split("\n").find(l => l.includes("Parse error") || l.includes("Fatal error")) || "";
      if (line) errors.push(`${relative(repoRoot, f).replace(/\\/g, "/")}: ${line.trim()}`);
    }
  }
  if (bad > 0) throw new Error(`${bad}/${phpFiles.length} PHP files have syntax errors: ${errors.join("; ").slice(0, 150)}`);
  return `${phpFiles.length} PHP files OK`;
});

// ─── Gate 7: Python tests ────────────────────────────────────────────────────
run("Python tests", () => {
  if (!hasBin("python")) throw new SkipError("python not installed");
  const testsDir = join(repoRoot, "tests");
  if (!existsSync(testsDir) && !existsSync(join(repoRoot, "test_python"))) {
    throw new SkipError("no tests/ or test_python/ directory");
  }
  // Scope pytest to the repo-root tests/ directory only.
  // Pre-existing script-style files elsewhere (e.g. modelwiki-theme/tests/test_material_parser.py)
  // call sys.exit() at module load and break pytest collection — they are NOT proper
  // pytest tests. This is a carry-over item for the reviewer to clean up.
  const pytestArgs = [
    "python", "-m", "pytest",
    testsDir,
    "--tb=line", "-q",
    "--ignore=" + join(repoRoot, "modelwiki-theme", "tests", "test_material_parser.py"),
  ];
  try {
    const out = execSync(pytestArgs.join(" "), { cwd: repoRoot, stdio: "pipe", encoding: "utf-8", timeout: 60000 });
    const m = out.match(/(\d+) passed/);
    return m ? `${m[1]} passed` : "pytest ran";
  } catch (e) {
    // pytest returns non-zero if tests fail OR if not installed
    const out = (e.stdout || "") + (e.stderr || "");
    if (out.includes("No module named pytest") || out.includes("pip install pytest")) {
      throw new SkipError("pytest not installed");
    }
    if (out.includes("no tests ran") || out.includes("ERROR not found")) {
      throw new SkipError("no tests collected from tests/");
    }
    const failLine = out.split("\n").find(l => l.includes("failed") || l.includes("error")) || "";
    throw new Error(failLine.trim().slice(0, 200) || out.slice(0, 200));
  }
});

// ─── Gate 8: secret scan ─────────────────────────────────────────────────────
run("secret scan", () => {
  const patterns = [
    { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
    { name: "OpenAI/Anthropic API key", re: /sk-[a-zA-Z0-9]{20,}/ },
    { name: "GitHub PAT", re: /ghp_[a-zA-Z0-9]{36}/ },
    { name: "PEM private key", re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
    { name: "hardcoded password assignment", re: /password\s*=\s*["'][^"']{8,}["']/i },
  ];
  const scanDirs = [
    join(backendDir, "src"),
    join(backendDir, "prisma"),
    join(repoRoot, "modelwiki-theme"),
  ];
  const exts = [".ts", ".js", ".mjs", ".sql", ".prisma", ".php"];
  const excludeRe = /node_modules|dist|\.test\.ts$|vendor|\.min\.js$/;
  const hits = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir)) {
      const full = join(dir, ent);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!excludeRe.test(full)) walk(full);
      } else {
        if (!exts.some(e => ent.endsWith(e))) continue;
        if (excludeRe.test(full)) continue;
        const content = readFileSync(full, "utf-8");
        for (const p of patterns) {
          if (p.re.test(content)) {
            hits.push(`${relative(repoRoot, full).replace(/\\/g, "/")} — ${p.name}`);
          }
        }
      }
    }
  }
  for (const d of scanDirs) walk(d);
  if (hits.length > 0) throw new Error(`${hits.length} hits: ${hits.slice(0, 3).join("; ").slice(0, 150)}`);
  return "no secrets found in src/prisma/modelwiki-theme";
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log("");
console.log("=== GATE SUMMARY ===");
for (const r of results) {
  console.log(`  ${r.status.padEnd(4)} ${r.name}${r.detail ? " — " + r.detail : ""}`);
}
console.log("");
const passN = results.filter(r => r.status === "PASS").length;
const skipN = results.filter(r => r.status === "SKIP").length;
const failN = results.filter(r => r.status === "FAIL").length;
console.log(`Total: ${passN} PASS, ${skipN} SKIP, ${failN} FAIL`);
process.exit(overallOk ? 0 : 1);
