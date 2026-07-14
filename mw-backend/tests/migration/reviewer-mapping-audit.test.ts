/**
 * Migration test: reviewer FK migration audit.
 *
 * Verifies the full reviewer FK migration flow:
 *   1. Pre-migration: review_items and review_decisions have reviewer_id
 *      pointing to users
 *   2. Dry-run classification script outputs all required fields (task #13)
 *   3. Post-migration: reviewer_id is NULLed, original values preserved in
 *      _reviewer_fk_migration_audit table (task #15)
 *   4. No ReviewItem or ReviewDecision records are deleted (task #14)
 *
 * Coverage: reviewer mapping.
 *
 * Requires:
 *   DATABASE_URL — disposable PostgreSQL connection string (NOT production)
 *   @prisma/client generated (for dry-run script)
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createDbHelpers } from "./helpers";
import { generateReport } from "../../scripts/migration/dry-run-classify";

const { setup, runSql, runSqlRows, execSql, execPrisma, applyMigrationSql, dbUrl } = createDbHelpers("mw_test_reviewer");

// Captured dry-run output (set in before hook)
let dryRunOutput: any = null;

describe("Reviewer FK migration audit", { timeout: 300000 }, () => {
  before(async () => {
    setup();

    // 1. Apply first 3 migrations + resolve --applied (baseline flow)
    applyMigrationSql("20260712000000_baseline_tables");
    applyMigrationSql("20260713000000_phase12_review_workflow");
    applyMigrationSql("20260713000001_review_storage_agent_a");
    execPrisma("migrate resolve --applied 20260712000000_baseline_tables");
    execPrisma("migrate resolve --applied 20260713000000_phase12_review_workflow");
    execPrisma("migrate resolve --applied 20260713000001_review_storage_agent_a");

    // 2. Seed pre-migration data with reviewer_ids pointing to users
    execSql(`INSERT INTO "users" ("id", "display_name", "role", "is_active", "updated_at") VALUES (10, 'Reviewer User A', 'user', true, CURRENT_TIMESTAMP), (20, 'Reviewer User B', 'user', true, CURRENT_TIMESTAMP);`);
    execSql(`SELECT setval('"users_id_seq"', (SELECT MAX(id) FROM "users"));`);

    execSql(`INSERT INTO "review_items" ("id", "type", "title", "status", "reviewer_id", "evidence_fingerprint", "updated_at") VALUES ('10', 'general', 'Review Item A', 'pending', 10, 'fp_audit_001', CURRENT_TIMESTAMP), ('20', 'general', 'Review Item B', 'pending', 20, 'fp_audit_002', CURRENT_TIMESTAMP), ('30', 'general', 'Review Item No Reviewer', 'pending', NULL, 'fp_audit_003', CURRENT_TIMESTAMP);`);

    execSql(`INSERT INTO "review_decisions" ("id", "review_item_id", "reviewer_id", "reviewer_role", "evidence_fingerprint", "action", "status_before", "status_after", "created_at") VALUES (10, '10', 10, 'admin', 'fp_audit_001', 'approve', 'pending', 'approved', CURRENT_TIMESTAMP), (20, '20', 20, 'reviewer', 'fp_audit_002', 'reject', 'pending', 'rejected', CURRENT_TIMESTAMP);`);
    execSql(`SELECT setval('"review_decisions_id_seq"', (SELECT MAX(id) FROM "review_decisions"));`);

    // 3. Run dry-run classification (zero DB writes) by importing generateReport
    //    directly. This avoids subprocess stdout capture issues in sandboxed
    //    environments. The function performs ONLY read-only SELECT queries.
    dryRunOutput = await generateReport(dbUrl);

    // 4. Apply account_schema migration
    execPrisma("migrate deploy");
  });

  // ─── Dry-run output verification (task #13) ───────────────────────────────
  it("should output all required reviewer FK fields from dry-run script", () => {
    assert.ok(dryRunOutput, "Dry-run output should be captured");
    const rfm = dryRunOutput.reviewerFkMigration;
    assert.ok(rfm, "reviewerFkMigration section should exist");

    assert.equal(typeof rfm.reviewItemsWithReviewerBefore, "number", "reviewItemsWithReviewerBefore");
    assert.equal(typeof rfm.reviewDecisionsWithReviewerBefore, "number", "reviewDecisionsWithReviewerBefore");
    assert.ok(Array.isArray(rfm.distinctReviewerIds), "distinctReviewerIds");
    assert.ok(Array.isArray(rfm.automaticallyMapped), "automaticallyMapped");
    assert.ok(Array.isArray(rfm.unmappedReviewerIds), "unmappedReviewerIds");
    assert.ok(Array.isArray(rfm.nullifiedReviewerIds), "nullifiedReviewerIds");
    assert.equal(typeof rfm.reviewItemsAfter, "number", "reviewItemsAfter");
    assert.equal(typeof rfm.reviewDecisionsAfter, "number", "reviewDecisionsAfter");
  });

  it("should report correct pre-migration reviewer counts", () => {
    const rfm = dryRunOutput.reviewerFkMigration;
    assert.equal(rfm.reviewItemsWithReviewerBefore, 2, "2 review items with reviewer_id");
    assert.equal(rfm.reviewDecisionsWithReviewerBefore, 2, "2 review decisions with reviewer_id");
  });

  it("should report distinct reviewer IDs correctly", () => {
    const rfm = dryRunOutput.reviewerFkMigration;
    assert.equal(rfm.distinctReviewerIds.length, 2, "2 distinct reviewer IDs (10, 20)");
    assert.ok(rfm.distinctReviewerIds.includes("10"), "reviewer_id 10 should be in distinct list");
    assert.ok(rfm.distinctReviewerIds.includes("20"), "reviewer_id 20 should be in distinct list");
  });

  it("should report all reviewer IDs as unmapped (admin_accounts is empty)", () => {
    const rfm = dryRunOutput.reviewerFkMigration;
    assert.equal(rfm.automaticallyMapped.length, 0, "no auto-mapping (admin_accounts empty)");
    assert.equal(rfm.unmappedReviewerIds.length, 2, "all 2 reviewer IDs unmapped");
    assert.equal(rfm.nullifiedReviewerIds.length, 2, "all 2 will be nullified");
  });

  it("should predict zero reviewer_ids after migration", () => {
    const rfm = dryRunOutput.reviewerFkMigration;
    assert.equal(rfm.reviewItemsAfter, 0, "0 review items with reviewer_id after migration");
    assert.equal(rfm.reviewDecisionsAfter, 0, "0 review decisions with reviewer_id after migration");
  });

  // ─── Audit table verification (task #15) ──────────────────────────────────
  it("should preserve original reviewer_ids in _reviewer_fk_migration_audit", () => {
    const rows = runSqlRows(`SELECT source_table, record_id, original_reviewer_id FROM "_reviewer_fk_migration_audit" ORDER BY source_table, record_id`);
    assert.equal(rows.length, 4, "Should have 4 audit records (2 items + 2 decisions)");

    const itemRows = rows.filter(r => r[0] === "review_items");
    assert.equal(itemRows.length, 2, "2 review_items audit records");
    assert.equal(itemRows[0][2], "10", "First item original_reviewer_id = 10");
    assert.equal(itemRows[1][2], "20", "Second item original_reviewer_id = 20");

    const decisionRows = rows.filter(r => r[0] === "review_decisions");
    assert.equal(decisionRows.length, 2, "2 review_decisions audit records");
    assert.equal(decisionRows[0][2], "10", "First decision original_reviewer_id = 10");
    assert.equal(decisionRows[1][2], "20", "Second decision original_reviewer_id = 20");
  });

  // ─── No data deletion (task #14) ──────────────────────────────────────────
  it("should not delete any ReviewItem records", () => {
    const count = runSql(`SELECT count(*) FROM "review_items" WHERE id IN ('10', '20', '30')`);
    assert.equal(count, "3", "All 3 review items must be preserved");
  });

  it("should not delete any ReviewDecision records", () => {
    const count = runSql(`SELECT count(*) FROM "review_decisions" WHERE id IN (10, 20)`);
    assert.equal(count, "2", "Both review decisions must be preserved");
  });

  // ─── reviewer_id NULLed ───────────────────────────────────────────────────
  it("should NULL all reviewer_id values in review_items", () => {
    const count = runSql(`SELECT count(*) FROM "review_items" WHERE id IN ('10', '20') AND reviewer_id IS NULL`);
    assert.equal(count, "2", "Both reviewer_ids should be NULLed");
  });

  it("should NULL all reviewer_id values in review_decisions", () => {
    const count = runSql(`SELECT count(*) FROM "review_decisions" WHERE id IN (10, 20) AND reviewer_id IS NULL`);
    assert.equal(count, "2", "Both reviewer_ids should be NULLed");
  });

  // ─── FK target verification ───────────────────────────────────────────────
  it("should have reviewer FK pointing to admin_accounts after migration", () => {
    const r = runSql(`SELECT ccu.table_name FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.table_name = 'review_items' AND tc.constraint_type = 'FOREIGN KEY' AND tc.constraint_name = 'review_items_reviewer_id_fkey'`);
    assert.equal(r.trim(), "admin_accounts", "review_items.reviewer_id FK must point to admin_accounts");
  });
});
