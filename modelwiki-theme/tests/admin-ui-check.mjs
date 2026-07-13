// Admin UI static check — verifies JS syntax + key functions/actions/guards exist.
// Run: node modelwiki-theme/tests/admin-ui-check.mjs
//
// This is a STATIC check (no browser needed). It:
//   1. Extracts every <script> block from page-guanli.php and runs `node --check`.
//   2. Verifies reviewActionName function exists.
//   3. Verifies all 7 review action strings are present.
//   4. Verifies double-click guard logic exists.
//   5. Verifies AbortController usage.
//   6. Verifies the 4 review card sections exist.
//   7. Verifies object URL lifecycle management (revokeObjectURL).

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..", "..");

// Support both canonical modelwiki-theme/page-guanli.php and legacy guanli_index.php
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

let allOk = true;
function check(name, condition, detail) {
  if (condition) {
    console.log("PASS: " + name);
  } else {
    console.log("FAIL: " + name + (detail ? " — " + detail : ""));
    allOk = false;
  }
}

// --- 1. Static string checks ---

check("reviewActionName function defined",
  /function\s+reviewActionName\s*\(/.test(php),
  "reviewActionName function not found");

// 7 canonical review actions (contract §3, task §4)
const ACTIONS = [
  "approve_image",
  "reject_image",
  "keep_placeholder",
  "request_refetch",
  "keep_pending",
  "mark_detail_ok",
  "mark_needs_manual_edit",
];
for (const a of ACTIONS) {
  check("action string present: " + a, php.includes(a), "string not found in PHP");
}

// --- 2. Double-click guard logic ---

check("inflight dedup map (state.inflight)",
  /state\.inflight/.test(php),
  "state.inflight not referenced");

check("isReviewActionInflight helper",
  /function\s+isReviewActionInflight\s*\(/.test(php),
  "isReviewActionInflight function not found");

check("reviewActionKey helper (id+action dedup key)",
  /function\s+reviewActionKey\s*\(/.test(php),
  "reviewActionKey function not found");

check("double-click guard in click handler",
  /isReviewActionInflight\(id,\s*action\)/.test(php),
  "click handler does not call isReviewActionInflight");

check("button disabled during action (rowLoading)",
  /state\.loading\['reviewAction_'\s*\+\s*id\]/.test(php),
  "rowLoading flag not used");

// --- 3. AbortController usage ---

check("AbortController constructed",
  /new\s+AbortController\(\)/.test(php),
  "no new AbortController() found");

check("AbortController stored in map",
  /reviewActionControllers\.set/.test(php),
  "controller not stored for abort");

check("abortReviewActions on page switch",
  /abortReviewActions\(\)/.test(php),
  "abortReviewActions not called");

check("signal passed to fetch via api()",
  /opts\.signal\s*=\s*signal/.test(php),
  "signal not forwarded to fetch options");

check("AbortError handled silently",
  /AbortError/.test(php),
  "AbortError not handled in catch");

// --- 4. Four review card sections ---

check("section helper (renderReviewSection)",
  /function\s+renderReviewSection\s*\(/.test(php),
  "renderReviewSection not found");

check("section: renderOriginalEvidence",
  /function\s+renderOriginalEvidence\s*\(/.test(php));

check("section: renderCurrentState",
  /function\s+renderCurrentState\s*\(/.test(php));

check("section: renderCandidate",
  /function\s+renderCandidate\s*\(/.test(php));

check("section: renderDecisionHistory",
  /function\s+renderDecisionHistory\s*\(/.test(php));

check("section title: Original Evidence",
  /Original Evidence/.test(php));

check("section title: Current State",
  /Current State/.test(php));

check("section title: Candidate",
  />Candidate</.test(php) || /候选 \/ Candidate/.test(php));

check("section title: Decision History",
  /Decision History/.test(php));

// --- 5. Object URL lifecycle management ---

check("URL.createObjectURL used",
  /URL\.createObjectURL/.test(php));

check("URL.revokeObjectURL used (lifecycle management)",
  /URL\.revokeObjectURL/.test(php),
  "revokeObjectURL not called — object URL leak risk");

check("reviewObjectUrls cache (reuse on re-render)",
  /state\.reviewObjectUrls/.test(php));

check("revokeReviewObjectUrls on leaving review section",
  /revokeReviewObjectUrls\(\)/.test(php));

// --- 6. Preview / lightbox consistency (contract §11) ---

check("data-review-lightbox attribute (lightbox trigger)",
  /data-review-lightbox/.test(php));

check("data-review-image-url attribute (preview loader)",
  /data-review-image-url/.test(php));

// --- 7. No frontend spoofing — API calls for actions ---

check("handleReviewAction calls api() (no local spoofing)",
  /handleReviewAction/.test(php) && /api\(endpoint,\s*'POST'/.test(php),
  "handleReviewAction must call api() for real backend confirmation");

check("loadReviewItems called on success (refresh)",
  /loadReviewItems\(\)/.test(php));

// --- 8. Backward compat — handles missing currentFigure / currentStateSnapshot ---

check("currentStateSnapshot fallback (forward-compat)",
  /currentStateSnapshot/.test(php),
  "currentStateSnapshot not referenced — integration agent field not handled");

check("currentFigure fallback (legacy-compat)",
  /currentFigure/.test(php));

// --- 9. JS syntax check — extract <script> blocks and node --check each ---

const scriptBlockRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
let blockIdx = 0;
let blockOk = 0;
let blockBad = 0;
let m;
while ((m = scriptBlockRe.exec(php)) !== null) {
  blockIdx++;
  const code = m[1];
  if (!code.trim()) continue;
  const tmp = join(tmpdir(), `admin-ui-block-${blockIdx}-${Date.now()}.js`);
  writeFileSync(tmp, code, "utf-8");
  try {
    execSync(`node --check "${tmp}"`, { stdio: "pipe", encoding: "utf-8", timeout: 10000 });
    blockOk++;
  } catch (e) {
    blockBad++;
    const stderr = e.stderr || "";
    const errLine = (stderr.split("\n").filter(l => l.includes("SyntaxError"))[0] || "").trim();
    console.log("FAIL: admin JS block #" + blockIdx + " syntax error: " + (errLine || e.message));
    allOk = false;
  }
  try { unlinkSync(tmp); } catch {}
}
console.log("admin-js blocks: " + blockOk + " ok, " + blockBad + " bad");

// --- Summary ---

console.log(allOk ? "admin-ui-check: ALL PASS" : "admin-ui-check: SOME FAILED");
process.exit(allOk ? 0 : 1);
