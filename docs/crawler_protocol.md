# Crawler Protocol

> Canonical reference for the ModelWiki CrawlerJob state machine, claim
> protocol, writeback protocol, and status history format.
>
> Source of truth: `docs/implementation/PHASE12_CONTRACT.md` §5
> Implementation: `nas_crawler_agent.py` (Python NAS agent) +
> `mw-backend/src/crawler/stateMachine.ts` (TypeScript backend repository)

---

## 1. The 7 Canonical Statuses

The CrawlerJob state machine has exactly **7** canonical status values.
No other status is accepted on new writes.

| Status | Meaning |
|---|---|
| `created` | Job record exists in PostgreSQL; not yet enqueued for a runner. Manual/admin canary jobs start here. |
| `queued` | Enqueued — visible to eligible runners via the queue index. |
| `claimed` | A runner has claimed it exclusively; work not yet started. |
| `running` | Runner is actively executing the fetch. |
| `completed` | Runner finished and wrote back successfully (3-step verification passed). |
| `failed` | Runner finished with error or max attempts exhausted. |
| `deferred` | Runner deferred (e.g. source 429/403/captcha); eligible for re-queue after `notBefore`. |

### Forbidden values

| Forbidden | Use instead |
|---|---|
| `succeeded` | `completed` |
| `cancelled` | `failed` (with `error` noting cancellation) |

The Python NAS agent (`nas_crawler_agent.py`) MUST NOT use `succeeded` or
`cancelled` as a status value. The backend reconciles legacy Redis values
via `LEGACY_CRAWLER_STATUS_MAP` on first persistence to PostgreSQL.

---

## 2. Legal State Transitions

```
created ──release/enqueue──▶ queued
queued ──claim──────────────▶ claimed
claimed ──start──────────────▶ running
running ──success────────────▶ completed
running ──error──────────────▶ failed
running ──429/403/captcha────▶ deferred
claimed ──timeout/release────▶ queued   (re-queue, attempt counter unchanged)
deferred ──notBefore passed──▶ queued    (re-queue, attempt counter unchanged)
failed ──admin retry─────────▶ created   (new attempt, attempt counter +1; capped at maxAttempts)
completed ──(terminal)──────▶ —
```

### Transition map (Python)

```python
LEGAL_TRANSITIONS = {
    "created": ["queued"],
    "queued": ["claimed"],
    "claimed": ["running", "queued"],
    "running": ["completed", "failed", "deferred"],
    "completed": [],          # terminal
    "failed": ["created"],    # admin retry only
    "deferred": ["queued"],
}
```

### Key rules

- `completed` is **terminal** — no outgoing transitions.
- `failed` can only transition to `created` (admin retry), not directly to
  `queued` or `running`.
- `claimed → deferred` is **illegal** — a claimed job that cannot proceed must
  be released back to `queued` (not deferred).
- `queued → completed` is **illegal** — a job must pass through
  `claimed → running → completed`.
- Attempt counter is **not** incremented on `claimed → queued` (release) or
  `deferred → queued` (re-queue). It IS incremented on `failed → created`
  (admin retry).

### Terminal statuses

`completed` and `failed` (at maxAttempts) are terminal. They have no legal
outgoing transitions (except `failed → created` via admin retry).

---

## 3. Claim Protocol

### Atomic server-side claim

All claim logic is **server-side**. The Python agent calls:

```
POST /admin/crawler/jobs/claim
```

The agent NEVER does queue-wide consumption on its own. The backend atomically
transitions `queued → claimed` (or `deferred → claimed` if `notBefore` has
passed), increments `attempts`, and sets `workerId`.

### Canary mode (exact jobIds)

When the runner operates in canary mode, the claim request MUST include
`jobIds: [id1, id2]`:

```json
{
  "runner": "local_browser",
  "workerId": "nas-mini-12345",
  "limit": 1,
  "jobIds": ["job-abc", "job-def"],
  "canaryMode": true
}
```

The server claims ONLY those ids. Queue-wide claim (empty `jobIds`) is
**forbidden** in canary mode (contract §5 + §12).

### Duplicate claim prevention

A job in `claimed` status cannot be claimed again by another agent. The
backend only claims jobs in `queued` or `deferred` (with `notBefore` passed)
status. The Python agent's transition validation also enforces:
`claimed → claimed` raises `IllegalTransitionError`.

### Concurrency

The NAS agent maintains `limit=1` (one job per poll cycle). This is NOT
increased. The agent does not execute large-scale or batch crawling.

---

## 4. Writeback Protocol (HTTP 200 ≠ completed)

A job is marked `completed` ONLY when all 3 steps pass:

### Step 1: Scrape succeeded

The page/data was successfully scraped. For `fetch_item` jobs, this means the
scraped data has a `name` field, or the item was intentionally `filtered`
(no usable data — the agent successfully classified the item as unusable).

### Step 2: Writeback succeeded

The figure was created or merged via the API
(`scraper.create_or_merge_figure(data)` returned a result with `id` and
`slug`). For search jobs, this step is N/A (no figure writeback).

### Step 3: Readback succeeded

The agent re-queries the API (`GET /figures/{slug}`) to confirm the data is
actually in the database. The readback checks:
- The figure exists (HTTP 200)
- The figure's `id` matches the writeback result
- Categories and images are present in the DB

If readback fails, the job is marked `failed` (NOT `completed`), with
`error_code = "COMPLETION_VERIFY_FAILED"`.

### Implementation

```python
def _verify_completion(self, job, result, result_summary):
    # Returns (ok: bool, reason: str)
    # Step 1: scrape succeeded
    # Step 2: writeback succeeded (figure_id + slug present)
    # Step 3: readback succeeded (result_summary["readback_ok"] == True)
```

The `resultSummary` dict includes a `readback_ok` boolean field that is
`True` only when the `GET /figures/{slug}` readback returned valid data.

---

## 5. Deferred / Manual Handling

### When to defer

A job is deferred (`running → deferred`) when:
- Cloudflare blocks the source (429/403/captcha challenge)
- The source is in cooldown (`source_blocked_until` not expired)
- A transient error occurs that is not a permanent failure

### What deferred preserves

- `error` field: the reason for deferral (e.g. `"CloudflareBlock: challenge failed"`)
- `notBefore` field: ISO 8601 timestamp after which the job is eligible for
  re-claim
- `attempts` field: NOT incremented for CF challenges (restored to pre-claim
  value so retry budget is not consumed)

### What deferred does NOT do

- It does NOT fake success. A deferred job is explicitly NOT `completed`.
- It does NOT permanently fail. The job will be re-queued when `notBefore`
  passes (`deferred → queued`).

### Unknown source handling

When the agent cannot determine the source of an item, it defers the job
(never fakes `completed`). The `error` field records the reason.

---

## 6. Idempotent request_refetch

### Principle

`request_refetch` (contract §3) MUST create exactly one CrawlerJob per active
window. Duplicate requests for the same item MUST NOT create duplicate jobs.

### Python agent implementation

The NAS agent's search handlers use `_create_fetch_item_job_idempotent()`,
which:

1. Queries `GET /admin/crawler/jobs?source={source}` for existing jobs.
2. Filters for active (non-terminal) jobs with the same `task` and `itemId`.
3. If an active job exists, skips creation and returns the existing job.
4. If no active job exists, creates a new job via `POST /admin/crawler/jobs`.

```python
def _create_fetch_item_job_idempotent(self, source, task, payload, ...):
    item_id = payload.get("itemId")
    existing = self._find_active_job(source, task, item_id)
    if existing:
        return existing, False  # not created
    job = self.create_job(body)
    return job, True  # created
```

### Backend-side enforcement

The backend's `request_refetch` action (admin.ts) also checks
`updatedItem.payload.crawlerJobId` for idempotency before creating a new job.
If a `crawlerJobId` already exists and the job is non-terminal, it reuses
the existing job.

---

## 7. Status History / Transition Event Format

Every status change is recorded as a **transition event** with the following
fields:

| Field | Type | Description |
|---|---|---|
| `previousStatus` | string \| null | Status before this transition (null for the first transition). |
| `nextStatus` | string | Status after this transition. |
| `agentId` | string | The worker ID of the agent that made the change (e.g. `nas-mini-12345`). |
| `runner` | string | The runner queue (e.g. `local_browser`, `proxy_browser`, `server_safe`). |
| `attempt` | int | Current attempt counter at the time of transition. |
| `timestamp` | string (ISO 8601) | UTC timestamp of the transition (e.g. `2026-07-13T12:00:00Z`). |
| `resultSummary` | object \| null | Structured summary of the job result (see below). |
| `error` | string \| null | Error message if the transition was due to a failure. |

### resultSummary structure

```json
{
  "source": "mfc",
  "itemId": "12345",
  "write_action": "created",
  "figure_id": 286,
  "slug": "test-figure",
  "readback_ok": true,
  "final_category_slugs": ["scale-figure", "original"],
  "final_db_image_counts": {"detail": 3, "thumb": 1, "raw": 0, "total": 4},
  "uploaded_image_counts": {"detail": 3, "thumb": 1, "raw": 0, "total": 4},
  "quality_flags": {
    "image_zero_count": false,
    "image_low_count": false,
    "category_summary_mismatch": false,
    "thumbnail_only": false,
    "upload_items_present": false
  },
  "cf_cleared": true,
  "cf_blocked": false,
  "error_code": null,
  "error_message": null
}
```

### Where events are stored

1. **Python agent (local)**: `self._transition_events` — an append-only list
   maintained in memory for the agent's lifetime. Used for debugging and
   testing.

2. **Backend payload**: The `transition` key is included in the `PUT
   /admin/crawler/jobs/:id` payload. The backend can persist this as a
   `CrawlerJobEvent` record (future enhancement).

### Example transition event

```json
{
  "jobId": "job-abc123",
  "previousStatus": "running",
  "nextStatus": "completed",
  "agentId": "nas-mini-12345",
  "runner": "local_browser",
  "attempt": 1,
  "timestamp": "2026-07-13T14:30:00Z",
  "resultSummary": {
    "write_action": "created",
    "figure_id": 286,
    "slug": "test-figure",
    "readback_ok": true
  },
  "error": null
}
```

---

## 8. Agent Lifecycle

### Normal flow

```
claim_jobs() → job status = "claimed"
  ↓
process_job()
  ├── update_job(status="running")        # claimed → running
  ├── handle_fetch_item() / handle_search()
  ├── _verify_completion()                # 3-step check
  │   ├── Step 1: scrape succeeded
  │   ├── Step 2: writeback succeeded
  │   └── Step 3: readback succeeded
  ├── if ok:  update_job(status="completed")  # running → completed
  └── if !ok: update_job(status="failed")     # running → failed
```

### Cloudflare block flow

```
process_job()
  ├── update_job(status="running")              # claimed → running
  ├── handle_fetch_item() → CloudflareBlockError
  └── update_job(status="deferred",             # running → deferred
        notBefore=cooldown_until,
        attempts=pre_claim_attempts,
        error="CloudflareBlock: ...")
```

### Shutdown flow

```
run() loop detects self._stopping = True
  └── update_job(status="queued", error="agent shutting down")
      # claimed → queued (release back to queue for another agent)
```

### Failure retry flow

```
running → failed (max attempts exhausted)
  ↓ admin retry
failed → created (attempt counter +1)
  ↓ release
created → queued
  ↓ claim
queued → claimed
  ↓ start
claimed → running
```

---

## 9. Cooldown and Backoff

### Source-level cooldown

When Cloudflare blocks a source, the agent records a cooldown timestamp
(`source_blocked_until[source] = ISO 8601`). All subsequent `fetch_item` jobs
for that source are deferred without retrying until the cooldown expires
(default: 30 minutes).

### Backoff

- 429 on `update_job`: exponential backoff with jitter (3 retries)
- 429 on image upload: exponential backoff (4 retries)
- Post-defer pause: clamped to [30, 120] seconds to avoid claim/defer thrashing
- Source-specific delay between jobs: MFC 15-30s, AmiAmi 5-10s, HobbySearch 8-15s

### No concurrency increase

The agent maintains `limit=1` (one job per poll cycle). This is a deliberate
safety constraint — the NAS agent is designed for residential-IP crawling,
not high-throughput batch processing.
