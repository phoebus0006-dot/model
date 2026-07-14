// QA Gate — contract section 8/9/16.
//
// Runs all QA gates and produces a machine-readable manifest (JSON).
// Each gate is classified as PASS, FAIL, or NOT_TESTED.
//   PASS        — command ran and exited 0
//   FAIL        — command ran and exited non-zero (→ overall gate FAIL)
//   NOT_TESTED  — environment missing (e.g. no Docker, no PHP, no browser)
//                 Reported transparently; does NOT cause overall gate failure.
//
// Contract section 9: "Environment missing → FAILED or NOT_TESTED (not skip-then-PASS)"
// NOT_TESTED is explicitly reported — it is never silently treated as PASS.
//
// Usage:
//   node scripts/gate.mjs              # run ALL gates
//   node scripts/gate.mjs --only <name> # run ONE gate (exit 1 if NOT_TESTED)
//   node scripts/gate.mjs --json        # output manifest JSON to stdout
//
// Manifest JSON schema (contract section 2):
//   {
//     "generated_at": "ISO timestamp",
//     "gates": [
//       { "name", "suite_type", "status", "detail", "duration_ms",
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

function runGate(name, suiteType, fn) {
  if (onlyName && onlyName !== name) return;

  const start = Date.now();
  let status, detail, counts = {};

  try {
    const result = fn();
    status = "PASS";
    detail = typeof result === "string" ? result : result.detail || "";
    counts = result.counts || {};
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
  const entry = { name, suite_type: suiteType, status, detail, duration_ms, ...counts };
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
    return out.trim().split("\n").pop();
  } catch (e) {
    throw new Error((e.stderr || e.stdout || e.message).slice(0, 200));
  }
});

// ─── Gate: typecheck ─────────────────────────────────────────────────────────
runGate("typecheck", "typescript", () => {
  try {
    exec("npx tsc --noEmit");
    return "tsc: no errors";
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    const lines = out.split("\n").filter(l => l.trim() && !l.startsWith("node:")).slice(0, 5);
    throw new Error(lines.join(" | ").slice(0, 200));
  }
});

// ─── Gate: build ──────────────────────────────────────────────────────────────
runGate("build", "typescript", () => {
  try {
    const out = exec("npx tsup src/index.ts --format esm --external @prisma/client --external bcryptjs --external sharp --no-sourcemap");
    if (out.includes("Build success") || out.includes("Build done")) {
      const m = out.match(/(\d+(?:\.\d+)?)\s*KB/);
      return m ? `dist ${m[1]} KB` : "build ok";
    }
    throw new Error(out.slice(-200));
  } catch (e) {
    throw new Error((e.stdout || e.stderr || e.message).slice(0, 200));
  }
});

// ─── Gate: lint (JS tooling syntax) ──────────────────────────────────────────
runGate("lint", "lint", () => {
  try {
    exec("node --check scripts/gate.mjs");
    exec("node --check scripts/admin-js-check.mjs");
    return "gate.mjs + admin-js-check.mjs syntax OK";
  } catch (e) {
    throw new Error((e.stderr || e.stdout || e.message).slice(0, 200));
  }
});

// ─── Gate: admin-js-check ─────────────────────────────────────────────────────
runGate("admin-js-check", "static-check", () => {
  // Contract section 10: admin-js-check SyntaxError → exit 1.
  // The admin-js-check.mjs already exits 1 on SyntaxError. We just propagate.
  try {
    const out = exec("node scripts/admin-js-check.mjs");
    if (out.includes("ALL PASS")) return "admin-js: ALL PASS";
    throw new Error(out.split("\n").filter(l => l.includes("FAIL")).join(" | ").slice(0, 200) || "admin-js check failed");
  } catch (e) {
    throw new Error((e.stdout || e.stderr || e.message).slice(0, 200));
  }
});

// ─── Gate: test:unit (src/**/*.test.ts — co-located unit tests) ───────────────
runGate("test-unit", "unit", () => {
  const testFiles = findFiles(join(backendDir, "src"), ".test.ts");
  if (testFiles.length === 0) throw new NotTestedError("no *.test.ts files under src/");
  const rel = testFiles.map(f => `"${relative(backendDir, f).replace(/\\/g, "/")}"`).join(" ");
  try {
    const out = exec(`npx tsx --test ${rel}`);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} unit tests failed`);
    return { detail: `${counts.passed}/${counts.executed} unit tests pass`, counts: { ...counts, discovered: testFiles.length } };
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
  try {
    const out = exec(`npx tsx --test ${rel}`);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} smoke tests failed`);
    return { detail: `${counts.passed}/${counts.executed} smoke tests pass`, counts: { ...counts, discovered: testFiles.length } };
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

// ─── Gate: test:route (tests/mock/**/*.test.ts — mock route integration) ──────
runGate("test-route", "mock-route", () => {
  const mockDir = join(backendDir, "tests", "mock");
  const testFiles = findFiles(mockDir, ".test.ts");
  if (testFiles.length === 0) throw new NotTestedError("no *.test.ts files under tests/mock/");
  const rel = testFiles.map(f => `"${relative(backendDir, f).replace(/\\/g, "/")}"`).join(" ");
  try {
    const out = exec(`npx tsx --test ${rel}`);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} mock route tests failed`);
    return { detail: `${counts.passed}/${counts.executed} mock route tests pass`, counts: { ...counts, discovered: testFiles.length } };
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
  try {
    const out = exec(`npx tsx --test ${rel}`);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} integration tests failed`);
    return { detail: `${counts.passed}/${counts.executed} integration tests pass`, counts: { ...counts, discovered: testFiles.length } };
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

// ─── Gate: test:migration (tests/migration/**/*.test.ts — prisma migrate) ─────
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
  try {
    const out = exec(`npx tsx --test ${rel}`);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} migration tests failed`);
    return { detail: `${counts.passed}/${counts.executed} migration tests pass`, counts: { ...counts, discovered: testFiles.length } };
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
  return { detail: `${phpFiles.length} PHP files OK`, counts: { discovered: phpFiles.length, executed: phpFiles.length, passed: phpFiles.length, failed: 0, skipped: 0 } };
});

// ─── Gate: test:python (Python tests via pytest) ─────────────────────────────
runGate("python-tests", "python", () => {
  if (!hasBin("python")) throw new NotTestedError("python not installed");

  const testsDir = join(repoRoot, "tests");
  if (!existsSync(testsDir)) throw new NotTestedError("no tests/ directory at repo root");

  try {
    const out = execSync("python -m pytest tests/ --tb=line -q", {
      cwd: repoRoot, stdio: "pipe", encoding: "utf-8", timeout: 60000,
    });
    const m = out.match(/(\d+) passed/);
    const passed = m ? +m[1] : 0;
    return { detail: `${passed} python tests passed`, counts: { discovered: passed, executed: passed, passed, failed: 0, skipped: 0 } };
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    if (out.includes("No module named pytest") || out.includes("pip install pytest")) {
      throw new NotTestedError("pytest not installed");
    }
    if (out.includes("no tests ran") || out.includes("ERROR not found")) {
      throw new NotTestedError("no tests collected from tests/");
    }
    const passedM = out.match(/(\d+) passed/);
    const failedM = out.match(/(\d+) failed/);
    const passed = passedM ? +passedM[1] : 0;
    const failed = failedM ? +failedM[1] : 0;
    const failLine = out.split("\n").find(l => l.includes("failed") || l.includes("error")) || "";
    const err = new Error(failLine.trim().slice(0, 200) || out.slice(0, 200));
    err.counts = { discovered: passed + failed, executed: passed + failed, passed, failed, skipped: 0 };
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
  try {
    const out = exec(`npx tsx --test ${rel}`);
    const counts = parseTestOutput(out);
    if (counts.failed > 0) throw new Error(`${counts.failed}/${counts.executed} E2E tests failed`);
    return { detail: `${counts.passed}/${counts.executed} E2E tests pass`, counts: { ...counts, discovered: testFiles.length } };
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
  return "no secrets found in src/prisma/modelwiki-theme";
});

// ─── Summary + Manifest ──────────────────────────────────────────────────────
const passN = results.filter(r => r.status === "PASS").length;
const failN = results.filter(r => r.status === "FAIL").length;
const notTestedN = results.filter(r => r.status === "NOT_TESTED").length;

const manifest = {
  generated_at: new Date().toISOString(),
  gates: results,
  summary: {
    pass: passN,
    fail: failN,
    not_tested: notTestedN,
    total: results.length,
  },
  overall_exit: overallOk ? 0 : 1,
};

// Write manifest JSON to file (always, for audit trail)
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
  console.log(`Manifest written to: ${relative(repoRoot, manifestPath).replace(/\\/g, "/")}`);
  console.log(overallOk ? "GATE: PASS" : "GATE: FAIL");
}

process.exit(overallOk ? 0 : 1);
