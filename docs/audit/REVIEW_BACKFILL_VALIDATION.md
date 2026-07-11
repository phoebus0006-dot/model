# Review Backfill Validation

## Test Scenarios (must pass before Stage 1 execution)

### 1. Idempotent Replay
Running the same Redis data through the backfill twice must produce the same PG rows (no duplicates).

**Mechanism**: UPSERT on `ReviewItem.publicId` UNIQUE constraint.
- First run: INSERT
- Second run: UPDATE (same data, no change)

### 2. Public ID Uniqueness
Each `review:item:{id}` key maps to exactly one `ReviewItem` row.
The `publicId` field stores the Redis ID suffix.

### 3. Event Order Stability
`ReviewEvent` entries are appended in chronological order.
- Creation event first
- Action events in timestamp order
- Recheck events in timestamp order

### 4. Missing Timestamp Fallback
If `item.createdAt` is missing → use current time (logged).
If `item.updatedAt` is missing → use `createdAt` fallback.
If `item.decisionAt` is missing → null.

### 5. Invalid JSON Isolation
Malformed `review:item:{id}` values are skipped and reported.
They do NOT:
- Block the backfill for other keys
- Cause silent data loss (logged as error for manual inspection)
- Create partial PG rows

### 6. Unknown Status Handling
Status values not in `reviewStatusSchema` are preserved as-is (not silently converted to pending).
Rationale: A future status value should not be lost during migration.

### 7. Missing Actor
When `item.reviewer` is missing/null → `ReviewEvent.actor = "system"`.

### 8. BigInt ID Preservation
`item.figureId` (when numeric) is preserved as BigInt without precision loss.
Redis stores it as string or number — backfill must handle both.

### 9. Evidence Fingerprint Preservation
`item.evidenceFingerprint` is preserved exactly.
If the unique constraint conflicts (two items with same fingerprint), the second is:
- Logged as warning
- Still inserted (remove unique constraint from PG if this is legitimate)

### 10. Format Versioning
Each backfilled row stores a `_formatVersion` field in payload (or separate column) to track which version of the backfill logic created it.

### 11. Dry-Run Semantics
Dry-run mode:
- Connects to Redis (read-only)
- Parses all matching keys
- Generates report of planned inserts/updates
- Does NOT connect to PostgreSQL
- Outputs: scanned, valid, invalid, planned_inserts, planned_updates, errors
