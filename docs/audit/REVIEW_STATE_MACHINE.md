# Review State Machine

Generated: 2026-07-11 | Source: `admin.ts:reviewActionSchema` + `actionStatusMap`

## States

```
pending → approved / rejected / needs_changes / resolved / stale
         → (via recheck: resolved / needs_changes)
```

All states are defined in `reviewStatusSchema`:

| State | Meaning |
|-------|---------|
| `pending` | Awaiting human review |
| `approved` | Human approved the item (e.g. image approved) |
| `rejected` | Human rejected the item |
| `needs_changes` | Automated requirements not met, or refetch requested |
| `resolved` | Item resolved (auto-recheck passed, placeholder kept, detail OK, dismissed) |
| `stale` | Old resolved items auto-marked by bulk cleanup |

## Actions

Defined in `reviewActionSchema`:

| Action | Target Status | Suppresses Decision | Creates Crawler Job | Purges Cache |
|--------|---------------|---------------------|---------------------|--------------|
| `approve_image` | approved | ✅ | ❌ | ✅ (figures:detail:*) |
| `reject_image` | rejected | ✅ | ❌ | ❌ |
| `keep_placeholder` | resolved | ✅ | ❌ | ✅ (figures:detail:*) |
| `mark_detail_ok` | resolved | ✅ | ❌ | ❌ |
| `request_refetch` | needs_changes | ❌ | ✅ (crawler job) | ❌ |
| `dismiss_stale` | resolved | ✅ | ❌ | ❌ |
| `keep_pending` | pending | ❌ | ❌ | ❌ |

## Transition Matrix

| Current ↓ | Action → | approve_image | reject_image | keep_placeholder | mark_detail_ok | request_refetch | dismiss_stale | keep_pending |
|-----------|-----------|---------------|--------------|------------------|---------------|-----------------|---------------|--------------|
| **pending** | | approved | rejected | resolved | resolved | needs_changes | resolved | pending |
| **approved** | | approved | rejected | resolved | resolved | needs_changes | resolved | pending |
| **rejected** | | approved | rejected | resolved | resolved | needs_changes | resolved | pending |
| **needs_changes** | | approved | rejected | resolved | resolved | needs_changes | resolved | pending |
| **resolved** | | approved | rejected | resolved | resolved | needs_changes | resolved | pending |
| **stale** | | approved | rejected | resolved | resolved | needs_changes | resolved | pending |

**All transitions are allowed — there is no invalid state transition in the current code.** The `actionStatusMap` blindly maps action → new status regardless of current status.

## Consequences

### Approve already-approved item (idempotent)
- Status stays `approved`
- Note appended with new timestamp
- Decision saved again (new timestamp)

### Reject already-approved item
- Status changes from `approved` → `rejected`
- Note appended

### keep_pending on pending
- Status stays `pending`
- Note appended (no-op)

### Recheck (POST /review/items/:id/recheck)
- Re-evaluates item against current DB state via `evaluateReviewItem()`
- Auto-sets status: `resolved` (no problems), `needs_changes` (deterministic problems), or keeps current (needs human judgment)
- Not a route in the action endpoint — separate recheck endpoint

## Concurrency Risk

**No concurrency protection exists.** Two admins can:
1. Read same item simultaneously (both see `pending`)
2. Apply different actions
3. Last `SET` wins — one admin's decision silently lost

## Dedup on Creation

`POST /review/items` dedup logic:
1. Check `review:decision:{key}` — if decision exists for same fingerprint, return `suppressed`
2. Check `findExistingPendingReview()` — scans all `review:items` sorted set, compares fingerprint/riskType/figureKey → if match, return `duplicate: true`

## Decision Suppression

`saveReviewDecision()` saves a permanent record for `isSuppressingReviewDecision` actions:
- Key format: `review:decision:{figureKey}:{riskType}:{fingerprint}`
- Future creation attempts with same fingerprint are suppressed
- Prevents the same issue from re-entering the review queue

## To Do

- [ ] Enforce invalid transitions (e.g., pending → needs_changes without recheck)
- [ ] Add conditional Redis updates (watch + multi or Lua script)
- [ ] Fix idempotent apply for image records (avoid UNIQUE constraint violation)
- [ ] Add audit log table in PostgreSQL
