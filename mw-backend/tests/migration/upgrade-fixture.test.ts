/**
 * Upgrade fixture migration test — non-empty baseline database.
 *
 * Verifies the formal existing-database baseline flow (task #7, #9):
 *   1. Pre-migration schema is set up by applying the first 3 migrations' SQL
 *   2. `prisma migrate resolve --applied` marks them in `_prisma_migrations`
 *   3. `prisma migrate deploy` applies the account_schema migration
 *
 * This does NOT bypass Prisma P3005 (task #8): the baseline flow uses
 * `prisma migrate resolve --applied` exactly as intended by Prisma for existing
 * databases. Direct SQL is used ONLY to reproduce the pre-existing schema
 * state (simulating an already-deployed database), not to apply new migrations.
 *
 * Coverage: non-empty baseline database, reviewer mapping, constraint verification.
 *
 * Requires:
 *   DATABASE_URL — disposable PostgreSQL connection string (NOT production)
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createDbHelpers } from "./helpers";

const { setup, runSql, runSqlRows, execSql, execPrisma, applyMigrationSql } = createDbHelpers("mw_test_upgrade");

describe("Upgrade fixture migration (baseline flow)", { timeout: 300000 }, () => {
  before(() => {
    setup();

    // 1. Apply the first 3 migrations' SQL directly (simulating an existing database)
    applyMigrationSql("20260712000000_baseline_tables");
    applyMigrationSql("20260713000000_phase12_review_workflow");
    applyMigrationSql("20260713000001_review_storage_agent_a");

    // 2. Mark the first 3 migrations as applied in _prisma_migrations via the
    //    formal Prisma baseline flow (NOT bypassing P3005).
    execPrisma("migrate resolve --applied 20260712000000_baseline_tables");
    execPrisma("migrate resolve --applied 20260713000000_phase12_review_workflow");
    execPrisma("migrate resolve --applied 20260713000001_review_storage_agent_a");

    // 3. Seed pre-migration test data
    //    Users without email (pre-account-schema state)
    execSql(`
      INSERT INTO "users" ("id", "display_name", "role", "is_active", "updated_at")
      VALUES
        (1, 'Existing User With No Email', 'user', true, CURRENT_TIMESTAMP),
        (2, 'Another User No Email', 'user', true, CURRENT_TIMESTAMP),
        (3, 'Admin-Like User', 'admin', true, CURRENT_TIMESTAMP);
    `);
    // Reset sequence
    execSql(`SELECT setval('"users_id_seq"', (SELECT MAX(id) FROM "users"));`);

    //    Review items with reviewer_id pointing to users (pre-migration FK target)
    //    NOTE: review_items.id is TEXT PRIMARY KEY (not BIGSERIAL), so string
    //    literals are required. There is no review_items_id_seq sequence.
    execSql(`
      INSERT INTO "review_items" ("id", "type", "title", "status", "reviewer_id", "evidence_fingerprint", "updated_at")
      VALUES
        ('1', 'general', 'Pre-migration review item 1', 'pending', 1, 'fp_seed_001', CURRENT_TIMESTAMP),
        ('2', 'image', 'Pre-migration review item 2', 'pending', 2, 'fp_seed_002', CURRENT_TIMESTAMP);
    `);

    //    Review decisions with reviewer_id pointing to users
    //    NOTE: review_decisions.id is BIGSERIAL, but review_item_id is TEXT
    //    (FK to review_items.id), so review_item_id needs string literals.
    execSql(`
      INSERT INTO "review_decisions" ("id", "review_item_id", "reviewer_id", "reviewer_role", "evidence_fingerprint", "action", "status_before", "status_after", "created_at")
      VALUES
        (1, '1', 1, 'admin', 'fp_seed_001', 'approve', 'pending', 'approved', CURRENT_TIMESTAMP),
        (2, '2', 2, 'admin', 'fp_seed_002', 'reject', 'pending', 'rejected', CURRENT_TIMESTAMP);
    `);
    execSql(`SELECT setval('"review_decisions_id_seq"', (SELECT MAX(id) FROM "review_decisions"));`);

    // 4. Apply the account_schema migration via `prisma migrate deploy`
    execPrisma("migrate deploy");
  });

  // ─── Data preservation (task #14: do NOT delete ReviewItem or ReviewDecision) ─
  it("should preserve existing users (no email) after migration", () => {
    const count = runSql(`SELECT count(*) FROM "users" WHERE display_name IN ('Existing User With No Email','Another User No Email','Admin-Like User')`);
    assert.equal(count, "3", "Existing 3 users should be preserved");
    const nullEmailCount = runSql(`SELECT count(*) FROM "users" WHERE email IS NULL AND display_name IN ('Existing User With No Email','Another User No Email','Admin-Like User')`);
    assert.equal(nullEmailCount, "3", "All existing users should have NULL email (not fabricated)");
  });

  it("should preserve all ReviewItem records (no deletion)", () => {
    const count = runSql(`SELECT count(*) FROM "review_items" WHERE id IN ('1', '2')`);
    assert.equal(count, "2", "Both pre-migration review items must be preserved");
  });

  it("should preserve all ReviewDecision records (no deletion)", () => {
    const count = runSql(`SELECT count(*) FROM "review_decisions" WHERE id IN (1, 2)`);
    assert.equal(count, "2", "Both pre-migration review decisions must be preserved");
  });

  // ─── Reviewer FK migration (task #13, #15) ─────────────────────────────────
  it("should NULL existing reviewer_id values in review_items (no auto-conversion)", () => {
    const count = runSql(`SELECT count(*) FROM "review_items" WHERE id IN ('1', '2') AND reviewer_id IS NULL`);
    assert.equal(count, "2", "Pre-migration reviewer_ids should be NULLed");
  });

  it("should NULL existing reviewer_id values in review_decisions", () => {
    const count = runSql(`SELECT count(*) FROM "review_decisions" WHERE id IN (1, 2) AND reviewer_id IS NULL`);
    assert.equal(count, "2", "reviewer_id should be NULLed for both decisions");
  });

  it("should preserve original reviewer_ids in _reviewer_fk_migration_audit table", () => {
    const rows = runSqlRows(`SELECT source_table, record_id, original_reviewer_id FROM "_reviewer_fk_migration_audit" ORDER BY source_table, record_id`);
    assert.equal(rows.length, 4, "Should have 4 audit records (2 review_items + 2 review_decisions)");

    const itemRows = rows.filter(r => r[0] === "review_items");
    assert.equal(itemRows.length, 2, "Should have 2 review_items audit records");
    assert.equal(itemRows[0][1], "1", "First review_item record_id should be 1");
    assert.equal(itemRows[0][2], "1", "First review_item original_reviewer_id should be 1");
    assert.equal(itemRows[1][1], "2", "Second review_item record_id should be 2");
    assert.equal(itemRows[1][2], "2", "Second review_item original_reviewer_id should be 2");

    const decisionRows = rows.filter(r => r[0] === "review_decisions");
    assert.equal(decisionRows.length, 2, "Should have 2 review_decisions audit records");
    assert.equal(decisionRows[0][2], "1", "First decision original_reviewer_id should be 1");
    assert.equal(decisionRows[1][2], "2", "Second decision original_reviewer_id should be 2");
  });

  it("should preserve review_decisions audit metadata (reviewerRole, evidenceFingerprint)", () => {
    const rows = runSqlRows(`SELECT id, reviewer_role, evidence_fingerprint FROM "review_decisions" WHERE id IN (1, 2) ORDER BY id`);
    assert.equal(rows.length, 2, "Pre-migration decisions should be preserved");
    assert.equal(rows[0][1], "admin", "Decision 1 reviewer_role retained");
    assert.equal(rows[0][2], "fp_seed_001", "Decision 1 evidenceFingerprint retained");
    assert.equal(rows[1][1], "admin", "Decision 2 reviewer_role retained");
    assert.equal(rows[1][2], "fp_seed_002", "Decision 2 evidenceFingerprint retained");
  });

  it("should have reviewer FK pointing to admin_accounts (not users)", () => {
    const r1 = runSql(`SELECT ccu.table_name FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.table_name = 'review_items' AND tc.constraint_type = 'FOREIGN KEY' AND tc.constraint_name = 'review_items_reviewer_id_fkey'`);
    assert.equal(r1.trim(), "admin_accounts", "review_items.reviewer_id FK must point to admin_accounts");
    const r2 = runSql(`SELECT ccu.table_name FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.table_name = 'review_decisions' AND tc.constraint_type = 'FOREIGN KEY' AND tc.constraint_name = 'review_decisions_reviewer_id_fkey'`);
    assert.equal(r2.trim(), "admin_accounts", "review_decisions.reviewer_id FK must point to admin_accounts");
  });

  // ─── New schema capabilities ──────────────────────────────────────────────
  it("should allow new user registration with email", () => {
    const ok = execSql(`
      INSERT INTO "users" ("email", "normalized_email", "display_name", "role", "is_active", "updated_at", "session_version")
      VALUES ('Test.User@Example.COM', 'test.user@example.com', 'New Email User', 'user', true, CURRENT_TIMESTAMP, 0)
    `);
    assert.ok(ok, "New user with email should be inserted");
    const rows = runSqlRows(`SELECT email, normalized_email FROM "users" WHERE display_name = 'New Email User'`);
    assert.equal(rows.length, 1, "New user should exist");
    assert.equal(rows[0][0], "Test.User@Example.COM", "email preserves original case");
    assert.equal(rows[0][1], "test.user@example.com", "normalized_email is lowercased");
  });

  it("should enforce unique email constraint", () => {
    const ok = execSql(`
      INSERT INTO "users" ("email", "display_name", "role", "is_active", "updated_at")
      VALUES ('Test.User@Example.COM', 'Duplicate Email', 'user', true, CURRENT_TIMESTAMP)
    `);
    assert.equal(ok, false, "Duplicate email should be rejected");
  });

  it("should allow AdminAccount creation", () => {
    const ok = execSql(`
      INSERT INTO "admin_accounts" ("username", "normalized_username", "password_hash", "display_name", "role", "is_active", "session_version", "updated_at")
      VALUES ('admin1', 'admin1', 'hashed_password_dummy', 'Admin One', 'admin', true, 0, CURRENT_TIMESTAMP)
    `);
    assert.ok(ok, "AdminAccount should be inserted");
  });

  it("should allow new ReviewItem with reviewer_id pointing to AdminAccount", () => {
    const adminId = runSql(`SELECT id FROM "admin_accounts" WHERE username = 'admin1' LIMIT 1`);
    assert.ok(adminId, "AdminAccount admin1 should exist");
    const ok = execSql(`
      INSERT INTO "review_items" ("id", "type", "title", "status", "reviewer_id", "evidence_fingerprint", "updated_at")
      VALUES ('post-migration-1', 'general', 'Post-migration review item', 'pending', ${adminId}, 'fp_post_001', CURRENT_TIMESTAMP)
    `);
    assert.ok(ok, "New ReviewItem with admin reviewer should be inserted");
  });

  it("should reject ReviewItem with reviewer_id pointing to non-existent AdminAccount", () => {
    const ok = execSql(`
      INSERT INTO "review_items" ("id", "type", "title", "status", "reviewer_id", "evidence_fingerprint", "updated_at")
      VALUES ('invalid-reviewer-test', 'general', 'Invalid reviewer test', 'pending', 99999999, 'fp_invalid', CURRENT_TIMESTAMP)
    `);
    assert.equal(ok, false, "FK constraint should reject non-existent admin_accounts id");
  });

  it("should allow user with NULL email (transitional: pre-cleanup)", () => {
    const ok = execSql(`
      INSERT INTO "users" ("display_name", "role", "is_active", "updated_at")
      VALUES ('Null Email User', 'user', true, CURRENT_TIMESTAMP)
    `);
    assert.ok(ok, "User with NULL email should be insertable (transitional)");
  });

  // ─── Migration history verification ───────────────────────────────────────
  it("should have all 4 migrations recorded in _prisma_migrations", () => {
    const rows = runSqlRows(`SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name`);
    assert.equal(rows.length, 4, `Expected 4 migrations, got ${rows.length}`);
    for (const r of rows) {
      assert.ok(r[0], "Migration name should be non-empty");
    }
  });
});
