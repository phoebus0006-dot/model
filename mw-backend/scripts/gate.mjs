// QA Gate — contract section 8/9/16.
//
// Runs all QA gates and produces a machine-readable manifest (JSON).
// Each gate is classified as PASS, FAIL, or NOT_TESTED.
//   PASS        — command ran and exited 0
//   FAIL        — command ran and exited non-zero (→ overall gate FAIL)
//   NOT_TESTED  — environment missing (e.g. no Docker, no PHP, no browser)
//                 Reported transparently; does NOT cause overall gate failure
//                 (locally). In CI, all environments MUST be installed so
//                 NOT_TESTED should not occur.
//
// Contract section 9: "Environment missing → FAILED or NOT_TESTED (not skip-then-PASS)"
// NOT_TESTED is explicitly reported — it is never silently treated as PASS.
//
// Skipped tests are reported in the `skipped` field and are NEVER counted as
// passed.  Detail strings explicitly mention skipped counts so they cannot be
// misread as "all passed".
//
// Usage:
//   node scripts/gate.mjs              # run ALL gates
//   node scripts/gate.mjs --only <name> # run ONE gate (exit 1 if NOT_TESTED)
//   node scripts/gate.mjs --json        # output manifest JSON to stdout
//
// Manifest JSON schema (contract section 2):
//   {
//     "generated_at": "ISO timestamp",
//     "commit_sha": "git HEAD SHA",
//     "environment": { "node", "python", "php", "os", "has_docker" },
//     "gates": [
//       { "name", "suite_type", "status", "detail", "duration_ms", "command",
//         "requires": ["postgresql"|"redis"|...],
//         "discovered", "executed", "passed", "failed", "skipped" }
//     ],
//     "summary": { "pass", "fail", "not_tested", "total" },
//     "overall_exit": 0 | 1
//   }

import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backendDir = join(__dirname, "..");
const repoRoot = join(__dirname, "..", "..");

// Parse CLI args
const args = process.argv.slice(2);
const onlyFlag = args.indexOf("--only");
const onlyName = onlyFlag >= 0 ? args[onlyFlag + 1] : null;
const jsonFlag = args.includes("--json");

const results = [];
let overallOk = true;

// ─── Environment helpers ─────────────────────────────────────────────────────
function getCommitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "unknown";
  }
}

function getEnvInfo() {
  const info = { node: process.version, os: `${process.platform}/${process.arch}` };
  for (const bin of ["python", "php", "docker"]) {
    try {
      const v = execSync(`${bin} --version`, { encoding: "utf-8", stdio: "pipe", timeout: 5000 });
      info[bin] = v.split("\n")[0].trim();
    } catch {
      info[bin] = "not installed";
    }
  }
  info.has_postgresql_url = !!process.env.DATABASE_URL;
  info.has_redis_url = !!process.env.REDIS_URL;
  return info;
}

const commitSha = getCommitSha();
const envInfo = getEnvInfo();

function hasBin(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: "pipe", encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { cwd: backendDir, encoding: "utf-8", timeout: 180000, stdio: "pipe", ...opts });
}

function findFiles(dir, ext, acc = [], excludeRe = /node_modules|dist|\.git/) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir)) {
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!excludeRe.test(full)) findFiles(full, ext, acc, excludeRe);
    } else if (ent.endsWith(ext)) {
      acc.push(full);
    }
  }
  return acc;
}

function parseTestOutput(out) {
  // node:test runner output: "ℹ tests N", "ℹ pass N", "ℹ fail N", "ℹ skipped N"
  const tests = out.match(/ℹ tests\s+(\d+)/);
  const pass = out.match(/ℹ pass\s+(\d+)/);
  const fail = out.match(/ℹ fail\s+(\d+)/);
  const skip = out.match(/ℹ skipped\s+(\d+)/);
  return {
    discovered: tests ? +tests[1] : 0,
    executed: tests ? +tests[1] : 0,
    passed: pass ? +pass[1] : 0,
    failed: fail ? +fail[1] : 0,
    skipped: skip ? +skip[1] : 0,
  };
}

// Format a detail string that explicitly separates passed / skipped / failed.
// This prevents skipped tests from being misread as "all passed".
function detailCounts(label, counts) {
  const parts = [`${counts.passed} passed`];
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  parts.push(`${counts.executed} executed`);
  return `${parts.join(", ")} (${label})`;
}

function runGate(name, suiteType, fn, opts = {}) {
  if (onlyName && onlyName !== name) return;

  const start = Date.now();
  let status, detail, counts = {};
  const requires = opts.requires || [];

  try {
    const result = fn();
    status = "PASS";
    detail = typeof result === "string" ? result : result.detail || "";
    counts = result.counts || {};
    if (result.command) counts._command = result.command;
  } catch (e) {
    if (e.notTested === true) {
      status = "NOT_TESTED";
      detail = e.message.slice(0, 200);
    } else {
      status = "FAIL";
      detail = (e.message || String(e)).slice(0, 200);
      overallOk = false;
    }
  }

  const duration_ms = Date.now() - start;
  const command = counts._command || opts.command || "";
  delete counts._command;
  const entry = { name, suite_type: suiteType, status, detail, duration_ms, command, requires, ...counts };
  results.push(entry);

  if (!jsonFlag) {
    const label = status === "NOT_TESTED" ? "NOT_TESTED" : status;
    console.log(`${label}: ${name}${detail ? " — " + detail : ""} (${duration_ms}ms)`);
  }

  // For --only mode: NOT_TESTED should also exit 1 (explicitly requested but can't run)
  if (onlyName && status === "NOT_TESTED") {
    overallOk = false;
  }
}

class NotTestedError extends Error {
  constructor(msg) { super(msg); this.notTested = true; }
}

// ─── Gate: prisma validate ──────────────────────────────────────────────────
runGate("prisma-validate", "schema", () => {
  if (!existsSync(join(backendDir, "prisma", "schema.prisma"))) {
    throw new NotTestedError("prisma/schema.prisma not found");
  }
  const env = { ...process.env };
  if (!env.DATABASE_URL) env.DATABASE_URL = "postgresql://placeholder:placeholder@localhost:5432/placeholder";
  try {
    const out = exec("npx prisma validate", { env });
    return { detail: out.trim().split("\n").pop(), command: "npx prisma validate" };
  } catch (e) {
    throw new Error((e.stderr || e.stdout || e.message).slice(0, 200));
  }
});

// ─── Gate: typecheck ─────────────────────────────────────────────────────────
runGate("typecheck", "typescript", () => {
  try {
    exec("npx tsc --noEmit");
    return { detail: "tsc: no errors", command: "npx tsc --noEmit" };
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    const lines = out.split("\n").filter(l => l.trim() && !l.startsWith("node:")).slice(0, 5);
    throw new Error(lines.join(" | ").slice(0, 200));
  }
});

// ─── Gate: build ──────────────────────────────────────────────────────────────
runGate("build", "typescript", () => {
  const cmd = "npx tsup src/index.ts --format esm --external @prisma/client --external bcryptjs --external sharp --no-sourcemap";
  try {
    const out = exec(cmd);
    if (out.includes("Build success") || out.includes("Build done")) {
      const m = out.match(/(\d+(?:\.\d+)?)\s*KB/);
      return { detail: m ? `dist ${m[1]} KB` : "build ok", command: cmd };
    }
    throw new Error(out.slice(-200));
  } catch (e) {
    throw new Error((e.stdout || e.stderr || e.message).slice(0, 200));
  }
});

// ─── Gate: lint (JS tooling syntax) ──────────────────────────────────────────
runGate("lint", "lint", () => {
  const cmd = "node --check scripts/gate.mjs && node --check scripts/admin-js-check.mjs";
  try {
    exec("node --check scripts/gate.mjs");
    exec("node --check scripts/admin-js-check.mjs");
    return { detail: "gate.mjs + admin-js-check.mjs syntax OK", command: cmd };
  } catch (e) {
    throw new Error((e.stderr || e.stdout || e.message).slice(0, 200));
  }
});

// ─── Gate: admin-js-check ─────────────────────────────────────────────────────
// Contract section 10: admin-js-check SyntaxError → exit 1.
// admin-js-check.mjs exits 1 on ANY failure (including SyntaxError in <script>
// blocks).  This gate propagates that non-zero exit as FAIL.
runGate("admin-js-check", "static-check", () => {
  const cmd = "node scripts/admin-js-check.mjs";
  try {
    const out = exec(cmd);
    if (out.includes("ALL PASS")) return { detail: "admin-js: ALL PASS", command: cmd };
    throw new Error(out.split("\n").filter(l => l.includes("FAIL")).join(" | ").slice(0, 200) || "admin-js check failed");
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    // Surface SyntaxError explicitly so it cannot be mistaken for a PASS.
    const syntaxLine = out.split("\n").find(l => l.includes("SyntaxError")) || "";
    throw new Error(syntaxLine.trim() || (e.stdout || e.stderr || e.message).slice(0, 200));
  }
});

// ─── Gate: test:unit (src/**/*.test.ts EXCLUDING src/routes/ — co-located unit tests) ────
runGate("test-unit", "unit", () => {
  // Exclude src/routes/ — those are classified as mock-route (see test-route gate).
  const testFiles = findFiles(join(backendDir, "src"), ".test.ts", [], /node_modules|dist|\.git|[\\/]routes(?:[\\/]|$)/);
  if (testFiles.length === 0) throw new NotTestedError("no *.test.ts files under src/ (excluding routes/)");
  const rel = testFiles.map(f => `"${relative(backendDir, f).replace(/\\/g, "/")}"`).join(" ");
  const cmd = `npx tsx --test ${rel}`;
  try {
    const out = exec(cmd);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} unit tests failed`);
    return { detail: detailCounts("unit", counts), counts: { ...counts, discovered: testFiles.length }, command: cmd };
  } catch (e) {
    if (e.notTested) throw e;
    const out = (e.stdout || "") + (e.stderr || "");
    const counts = parseTestOutput(out);
    const failLine = out.split("\n").find(l => l.includes("ℹ fail")) || "";
    const err = new Error(failLine.trim() || (e.message || "").slice(0, 200));
    if (counts.executed > 0) err.counts = counts;
    throw err;
  }
});

// ─── Gate: test:route (src/routes/**/*.test.ts — mock-based route handler tests) ──────
// These tests exercise route handlers with mocked Prisma/Redis dependencies.
// Separated from unit tests per contract section 8: "mock route 和 mock integration 必须单独分类".
runGate("test-route", "mock-route", () => {
  const testFiles = findFiles(join(backendDir, "src", "routes"), ".test.ts");
  if (testFiles.length === 0) throw new NotTestedError("no *.test.ts files under src/routes/");
  const rel = testFiles.map(f => `"${relative(backendDir, f).replace(/\\/g, "/")}"`).join(" ");
  const cmd = `npx tsx --test ${rel}`;
  try {
    const out = exec(cmd);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} mock route tests failed`);
    return { detail: detailCounts("mock-route", counts), counts: { ...counts, discovered: testFiles.length }, command: cmd };
  } catch (e) {
    if (e.notTested) throw e;
    const out = (e.stdout || "") + (e.stderr || "");
    const counts = parseTestOutput(out);
    const failLine = out.split("\n").find(l => l.includes("ℹ fail")) || "";
    const err = new Error(failLine.trim() || (e.message || "").slice(0, 200));
    if (counts.executed > 0) err.counts = counts;
    throw err;
  }
});

// ─── Gate: test:smoke (tests/smoke/**/*.test.ts — startup + isolation) ────────
runGate("test-smoke", "smoke", () => {
  const smokeDir = join(backendDir, "tests", "smoke");
  const testFiles = findFiles(smokeDir, ".test.ts");
  if (testFiles.length === 0) throw new NotTestedError("no *.test.ts files under tests/smoke/");
  const rel = testFiles.map(f => `"${relative(backendDir, f).replace(/\\/g, "/")}"`).join(" ");
  const cmd = `npx tsx --test ${rel}`;
  try {
    const out = exec(cmd);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} smoke tests failed`);
    return { detail: detailCounts("smoke", counts), counts: { ...counts, discovered: testFiles.length }, command: cmd };
  } catch (e) {
    if (e.notTested) throw e;
    const out = (e.stdout || "") + (e.stderr || "");
    const counts = parseTestOutput(out);
    const failLine = out.split("\n").find(l => l.includes("ℹ fail")) || "";
    const err = new Error(failLine.trim() || (e.message || "").slice(0, 200));
    if (counts.executed > 0) err.counts = counts;
    throw err;
  }
});

// ─── Gate: test:mock-integration (tests/mock/**/*.test.ts — mock integration skeletons) ──
// Separated from mock-route per contract section 8.
// These are integration test skeletons that are currently skipped (TODO).
// Skipped tests are reported in `skipped` and NEVER counted as passed.
runGate("test-mock-integration", "mock-integration", () => {
  const mockDir = join(backendDir, "tests", "mock");
  const testFiles = findFiles(mockDir, ".test.ts");
  if (testFiles.length === 0) throw new NotTestedError("no *.test.ts files under tests/mock/");
  const rel = testFiles.map(f => `"${relative(backendDir, f).replace(/\\/g, "/")}"`).join(" ");
  const cmd = `npx tsx --test ${rel}`;
  try {
    const out = exec(cmd);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} mock integration tests failed`);
    return { detail: detailCounts("mock-integration", counts), counts: { ...counts, discovered: testFiles.length }, command: cmd };
  } catch (e) {
    if (e.notTested) throw e;
    const out = (e.stdout || "") + (e.stderr || "");
    const counts = parseTestOutput(out);
    const failLine = out.split("\n").find(l => l.includes("ℹ fail")) || "";
    const err = new Error(failLine.trim() || (e.message || "").slice(0, 200));
    if (counts.executed > 0) err.counts = counts;
    throw err;
  }
});

// ─── Gate: test:integration (tests/real/**/*.test.ts — real PG + Redis) ───────
// Contract section 9: real PostgreSQL and Redis must be separately categorized.
// The `requires` field lists the services this gate needs.
runGate("test-integration", "real-postgresql-redis", () => {
  const realDir = join(backendDir, "tests", "real");
  const testFiles = findFiles(realDir, ".test.ts");
  if (testFiles.length === 0) throw new NotTestedError("no *.test.ts files under tests/real/");

  const dbUrl = process.env.DATABASE_URL || "";
  const redisUrl = process.env.REDIS_URL || "";
  const isDisposable = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");
  if (!dbUrl || !redisUrl || !isDisposable) {
    throw new NotTestedError("DATABASE_URL/REDIS_URL not set or not localhost (disposable DB required)");
  }

  const rel = testFiles.map(f => `"${relative(backendDir, f).replace(/\\/g, "/")}"`).join(" ");
  const cmd = `npx tsx --test ${rel}`;
  try {
    const out = exec(cmd);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} integration tests failed`);
    return { detail: detailCounts("real-pg-redis", counts), counts: { ...counts, discovered: testFiles.length }, command: cmd };
  } catch (e) {
    if (e.notTested) throw e;
    const out = (e.stdout || "") + (e.stderr || "");
    const counts = parseTestOutput(out);
    const failLine = out.split("\n").find(l => l.includes("ℹ fail")) || "";
    const err = new Error(failLine.trim() || (e.message || "").slice(0, 200));
    if (counts.executed > 0) err.counts = counts;
    throw err;
  }
}, { requires: ["postgresql", "redis"] });

// ─── Gate: test:migration (tests/migration/**/*.test.ts — prisma migrate) ─────
// Contract section 9: migration tests must be separately categorized.
runGate("test-migration", "migration", () => {
  const migDir = join(backendDir, "tests", "migration");
  const testFiles = findFiles(migDir, ".test.ts");
  if (testFiles.length === 0) throw new NotTestedError("no *.test.ts files under tests/migration/");

  const dbUrl = process.env.DATABASE_URL || "";
  const isDisposable = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");
  if (!dbUrl || !isDisposable) {
    throw new NotTestedError("DATABASE_URL not set or not localhost (disposable PG required)");
  }

  const rel = testFiles.map(f => `"${relative(backendDir, f).replace(/\\/g, "/")}"`).join(" ");
  const cmd = `npx tsx --test ${rel}`;
  try {
    const out = exec(cmd);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} migration tests failed`);
    return { detail: detailCounts("migration", counts), counts: { ...counts, discovered: testFiles.length }, command: cmd };
  } catch (e) {
    if (e.notTested) throw e;
    const out = (e.stdout || "") + (e.stderr || "");
    const counts = parseTestOutput(out);
    const failLine = out.split("\n").find(l => l.includes("ℹ fail")) || "";
    const err = new Error(failLine.trim() || (e.message || "").slice(0, 200));
    if (counts.executed > 0) err.counts = counts;
    throw err;
  }
}, { requires: ["postgresql"] });

// ─── Gate: test:php (PHP syntax check on all .php files) ─────────────────────
runGate("php-syntax", "php-syntax", () => {
  if (!hasBin("php")) throw new NotTestedError("php CLI not installed");

  const themeDir = join(repoRoot, "modelwiki-theme");
  if (!existsSync(themeDir)) throw new NotTestedError("modelwiki-theme/ not found");

  const phpFiles = findFiles(themeDir, ".php", [], /vendor|node_modules/);
  const rootGuanli = join(repoRoot, "guanli_index.php");
  if (existsSync(rootGuanli)) phpFiles.push(rootGuanli);

  if (phpFiles.length === 0) throw new NotTestedError("no *.php files found");

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
  return { detail: `${phpFiles.length} PHP files OK`, counts: { discovered: phpFiles.length, executed: phpFiles.length, passed: phpFiles.length, failed: 0, skipped: 0 }, command: "php -l <each .php file>" };
});

// ─── Gate: test:python (Python tests via pytest) ─────────────────────────────
// Discovers Python test files in:
//   1. Repo root: test_crawler_state.py (tests nas_crawler_agent.py)
//   2. modelwiki-theme/tests/*.py (theme Python tests)
// Sets PYTHONPATH=repoRoot so nas_crawler_agent can be imported.
runGate("python-tests", "python", () => {
  if (!hasBin("python")) throw new NotTestedError("python not installed");

  // Discover Python test files
  const pyTestFiles = [];

  // Root-level test files (test_*.py at repo root)
  const rootTest = join(repoRoot, "test_crawler_state.py");
  if (existsSync(rootTest)) pyTestFiles.push(rootTest);

  // NOTE: modelwiki-theme/tests/test_material_parser.py is a standalone script
  // (calls sys.exit at module level) and is NOT pytest-compatible.
  // It is syntax-checked via py_compile in CI, not run via pytest.

  if (pyTestFiles.length === 0) throw new NotTestedError("no Python test files found (test_crawler_state.py or modelwiki-theme/tests/*.py)");

  const relFiles = pyTestFiles.map(f => relative(repoRoot, f).replace(/\\/g, "/")).join(" ");
  const cmd = `python -m pytest ${relFiles} --tb=line -q`;
  const env = { ...process.env, PYTHONPATH: repoRoot };
  try {
    const out = execSync(cmd, {
      cwd: repoRoot, env, stdio: "pipe", encoding: "utf-8", timeout: 60000,
    });
    // Parse pytest summary: "N passed", "N skipped", "N failed"
    const passedM = out.match(/(\d+) passed/);
    const skippedM = out.match(/(\d+) skipped/);
    const failedM = out.match(/(\d+) failed/);
    const passed = passedM ? +passedM[1] : 0;
    const skipped = skippedM ? +skippedM[1] : 0;
    const failed = failedM ? +failedM[1] : 0;
    const executed = passed + skipped + failed;
    const counts = { discovered: pyTestFiles.length, executed, passed, failed, skipped };
    if (failed > 0) throw new Error(`${failed} python tests failed`);
    return { detail: detailCounts("python", counts), counts, command: cmd };
  } catch (e) {
    if (e.notTested) throw e;
    const out = (e.stdout || "") + (e.stderr || "");
    if (out.includes("No module named pytest") || out.includes("pip install pytest")) {
      throw new NotTestedError("pytest not installed");
    }
    const passedM = out.match(/(\d+) passed/);
    const skippedM = out.match(/(\d+) skipped/);
    const failedM = out.match(/(\d+) failed/);
    const passed = passedM ? +passedM[1] : 0;
    const skipped = skippedM ? +skippedM[1] : 0;
    const failed = failedM ? +failedM[1] : 0;
    const executed = passed + skipped + failed;
    const failLine = out.split("\n").find(l => l.includes("failed") || l.includes("error")) || "";
    const err = new Error(failLine.trim().slice(0, 200) || out.slice(0, 200));
    err.counts = { discovered: pyTestFiles.length, executed, passed, failed, skipped };
    throw err;
  }
});

// ─── Gate: test:e2e (browser E2E tests) ──────────────────────────────────────
runGate("test-e2e", "browser-e2e", () => {
  const e2eDir = join(backendDir, "tests", "e2e");
  const testFiles = findFiles(e2eDir, ".test.ts");
  if (testFiles.length === 0) throw new NotTestedError("no *.test.ts files under tests/e2e/");

  if (!process.env.E2E_BROWSER || process.env.E2E_BROWSER === "false") {
    throw new NotTestedError("E2E_BROWSER not set (no browser automation available)");
  }

  const rel = testFiles.map(f => `"${relative(backendDir, f).replace(/\\/g, "/")}"`).join(" ");
  const cmd = `npx tsx --test ${rel}`;
  try {
    const out = exec(cmd);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} E2E tests failed`);
    return { detail: detailCounts("e2e", counts), counts: { ...counts, discovered: testFiles.length }, command: cmd };
  } catch (e) {
    if (e.notTested) throw e;
    const out = (e.stdout || "") + (e.stderr || "");
    const counts = parseTestOutput(out);
    const failLine = out.split("\n").find(l => l.includes("ℹ fail")) || "";
    const err = new Error(failLine.trim() || (e.message || "").slice(0, 200));
    if (counts.executed > 0) err.counts = counts;
    throw err;
  }
});

// ─── Gate: secret scan ───────────────────────────────────────────────────────
runGate("secret-scan", "security", () => {
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
  return { detail: "no secrets found in src/prisma/modelwiki-theme", command: "regex scan src/prisma/modelwiki-theme" };
});

// ─── Summary + Manifest ──────────────────────────────────────────────────────
const passN = results.filter(r => r.status === "PASS").length;
const failN = results.filter(r => r.status === "FAIL").length;
const notTestedN = results.filter(r => r.status === "NOT_TESTED").length;

const manifest = {
  generated_at: new Date().toISOString(),
  commit_sha: commitSha,
  environment: envInfo,
  gates: results,
  summary: {
    pass: passN,
    fail: failN,
    not_tested: notTestedN,
    total: results.length,
  },
  overall_exit: overallOk ? 0 : 1,
};

// Write manifest JSON to file (always, for audit trail).
// This file is a CI artifact — NOT source code.  It is gitignored and should
// not be committed.  Each run overwrites it with fresh results that include
// the commit SHA, timestamp, environment, and commands used.
const manifestPath = join(backendDir, "test-manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

if (jsonFlag) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  console.log("");
  console.log("=== GATE SUMMARY ===");
  for (const r of results) {
    console.log(`  ${r.status.padEnd(12)} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log("");
  console.log(`Total: ${passN} PASS, ${failN} FAIL, ${notTestedN} NOT_TESTED`);
  console.log(`Commit: ${commitSha}`);
  console.log(`Manifest written to: ${relative(repoRoot, manifestPath).replace(/\\/g, "/")}`);
  console.log(overallOk ? "GATE: PASS" : "GATE: FAIL");
}

process.exit(overallOk ? 0 : 1);
