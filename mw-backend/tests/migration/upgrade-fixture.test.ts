/**
 * Migration test: upgrade fixture
 *
 * Verifies that the account schema migration preserves existing data,
 * allows new users with email, allows AdminAccount creation, allows
 * AdminAuditLog creation, allows ReviewItem with reviewer_id association
 * to AdminAccount, and that FK constraints reject invalid admin references.
 *
 * Per Wave 1 Agent Contract task #16: "upgrade fixture test"
 *
 * Strategy:
 *   1. Seed a pre-migration fixture (users table WITHOUT email columns,
 *      review_items with reviewer_id pointing to users) into a disposable DB.
 *   2. Apply the account_schema migration SQL directly via psql.
 *   3. Verify data preservation and new schema capabilities.
 *
 * Requires:
 *   DATABASE_URL — disposable PostgreSQL connection string
 *   (NOT production credentials)
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const DATABASE_URL = process.env.DATABASE_URL || "";
const DB_NAME = DATABASE_URL.split("/").pop() || "mw_test_upgrade";
const PSQL = path.join(process.env.TEMP || "", "pg17", "pgsql", "bin", "psql.exe");

function runSql(sql: string): string {
  try {
    return execSync(`"${PSQL}" -p 15432 -U testuser -d ${DB_NAME} -t -A -F "\t"`, {
      encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"], input: sql,
    }).trim().replace(/\r/g, "");
  } catch (e: any) {
    return e.stdout ? e.stdout.trim().replace(/\r/g, "") : "";
  }
}

function runSqlRows(sql: string): string[][] {
  const r = runSql(sql);
  if (!r) return [];
  return r.split("\n").map(l => l.split("\t"));
}

function execSql(sql: string): boolean {
  try {
    execSync(`"${PSQL}" -p 15432 -U testuser -d ${DB_NAME} -v ON_ERROR_STOP=1`, {
      encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"], input: sql,
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Pre-migration fixture: create the minimal pre-migration schema by hand
 * (without email columns, with reviewer_id -> users FK), seed data, then
 * apply the account_schema migration SQL on top.
 */
function seedPreMigrationFixture(): void {
  // Drop any existing tables to start clean
  execSql(`DROP TABLE IF EXISTS "review_decisions" CASCADE;`);
  execSql(`DROP TABLE IF EXISTS "review_items" CASCADE;`);
  execSql(`DROP TABLE IF EXISTS "users" CASCADE;`);
  execSql(`DROP TABLE IF EXISTS "admin_accounts" CASCADE;`);
  execSql(`DROP TABLE IF EXISTS "admin_audit_logs" CASCADE;`);
  execSql(`DROP TABLE IF EXISTS "_prisma_migrations" CASCADE;`);

  // Create pre-migration users table WITHOUT email columns
  execSql(`
    CREATE TABLE "users" (
      "id" BIGSERIAL NOT NULL,
      "password_hash" TEXT,
      "display_name" TEXT NOT NULL,
      "avatar_url" TEXT,
      "google_sub" TEXT UNIQUE,
      "wechat_openid" TEXT UNIQUE,
      "role" TEXT NOT NULL DEFAULT 'user',
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "users_pkey" PRIMARY KEY ("id")
    );
  `);

  // Create pre-migration review_items table with reviewer_id -> users FK
  execSql(`
    CREATE TABLE "review_items" (
      "id" BIGSERIAL NOT NULL,
      "type" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "priority" INTEGER NOT NULL DEFAULT 1,
      "reviewer_id" BIGINT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "review_items_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "review_items_reviewer_id_fkey"
        FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL
    );
  `);

  // Create pre-migration review_decisions table with reviewer_id -> users FK
  execSql(`
    CREATE TABLE "review_decisions" (
      "id" BIGSERIAL NOT NULL,
      "review_item_id" BIGINT NOT NULL,
      "reviewer_id" BIGINT,
      "reviewer_role" TEXT,
      "evidence_fingerprint" TEXT,
      "decision" TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "review_decisions_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "review_decisions_reviewer_id_fkey"
        FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL
    );
  `);

  // Seed pre-migration users (no email)
  execSql(`
    INSERT INTO "users" ("id", "display_name", "role", "is_active", "updated_at")
    VALUES
      (1, 'Existing User With No Email', 'user', true, CURRENT_TIMESTAMP),
      (2, 'Another User No Email', 'user', true, CURRENT_TIMESTAMP),
      (3, 'Admin-Like User', 'admin', true, CURRENT_TIMESTAMP);
  `);

  // Seed pre-migration review_items with reviewer_id pointing to users
  execSql(`
    INSERT INTO "review_items" ("id", "type", "title", "reviewer_id", "updated_at")
    VALUES
      (1, 'general', 'Pre-migration review item 1', 1, CURRENT_TIMESTAMP),
      (2, 'image', 'Pre-migration review item 2', 2, CURRENT_TIMESTAMP);
  `);

  // Seed pre-migration review_decisions with reviewer_id pointing to users
  execSql(`
    INSERT INTO "review_decisions" ("id", "review_item_id", "reviewer_id", "reviewer_role", "evidence_fingerprint", "decision")
    VALUES
      (1, 1, 1, 'admin', 'fp_seed_001', 'approved'),
      (2, 2, 2, 'admin', 'fp_seed_002', 'rejected');
  `);

  // Reset sequences so future inserts don't conflict with seeded IDs
  execSql(`SELECT setval('"users_id_seq"', (SELECT MAX(id) FROM "users"));`);
  execSql(`SELECT setval('"review_items_id_seq"', (SELECT MAX(id) FROM "review_items"));`);
  execSql(`SELECT setval('"review_decisions_id_seq"', (SELECT MAX(id) FROM "review_decisions"));`);
}

/**
 * Apply the account_schema migration SQL directly via psql.
 * This simulates what `prisma migrate deploy` would do, but without
 * Prisma's migration tracking (which conflicts with the pre-seeded fixture).
 */
function applyAccountSchemaMigration(): void {
  const migrationSqlPath = path.join(
    process.cwd(), "prisma", "migrations",
    "20260714000000_account_schema", "migration.sql"
  );
  if (!fs.existsSync(migrationSqlPath)) {
    throw new Error("Account schema migration SQL not found: " + migrationSqlPath);
  }
  const migrationSql = fs.readFileSync(migrationSqlPath, "utf-8");
  const ok = execSql(migrationSql);
  if (!ok) {
    throw new Error("Failed to apply account_schema migration SQL");
  }
}

describe("Upgrade fixture migration", { timeout: 180000 }, () => {
  before(() => {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL must be set to a disposable PostgreSQL instance");
    }

    // Seed pre-migration fixture
    seedPreMigrationFixture();

    // Apply the account schema migration SQL directly
    applyAccountSchemaMigration();
  });

  it("should preserve existing users (no email) after migration", () => {
    const count = runSql(`SELECT count(*) FROM "users" WHERE display_name IN ('Existing User With No Email','Another User No Email','Admin-Like User')`);
    assert.equal(count, "3", "Existing 3 users should be preserved");

    const nullEmailCount = runSql(`SELECT count(*) FROM "users" WHERE email IS NULL AND display_name IN ('Existing User With No Email','Another User No Email','Admin-Like User')`);
    assert.equal(nullEmailCount, "3", "All existing users should have NULL email (not fabricated)");
  });

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

  it("should enforce unique normalized_email constraint", () => {
    const ok = execSql(`
      INSERT INTO "users" ("email", "normalized_email", "display_name", "role", "is_active", "updated_at")
      VALUES ('other@example.org', 'test.user@example.com', 'Duplicate Normalized', 'user', true, CURRENT_TIMESTAMP)
    `);
    assert.equal(ok, false, "Duplicate normalized_email should be rejected");
  });

  it("should allow AdminAccount creation", () => {
    const ok = execSql(`
      INSERT INTO "admin_accounts" ("username", "normalized_username", "password_hash", "display_name", "role", "is_active", "session_version", "updated_at")
      VALUES ('admin1', 'admin1', 'hashed_password_dummy', 'Admin One', 'admin', true, 0, CURRENT_TIMESTAMP)
    `);
    assert.ok(ok, "AdminAccount should be inserted");

    const rows = runSqlRows(`SELECT username, role FROM "admin_accounts" WHERE username = 'admin1'`);
    assert.equal(rows.length, 1, "AdminAccount admin1 should exist");
    assert.equal(rows[0][0], "admin1", "username should be admin1");
    assert.equal(rows[0][1], "admin", "role should be admin");
  });

  it("should enforce unique username on AdminAccount", () => {
    const ok = execSql(`
      INSERT INTO "admin_accounts" ("username", "normalized_username", "password_hash", "display_name", "role", "updated_at")
      VALUES ('admin1', 'admin1', 'another_hash', 'Admin Duplicate', 'admin', CURRENT_TIMESTAMP)
    `);
    assert.equal(ok, false, "Duplicate admin username should be rejected");
  });

  it("should allow AdminAuditLog creation linked to AdminAccount", () => {
    const adminId = runSql(`SELECT id FROM "admin_accounts" WHERE username = 'admin1' LIMIT 1`);
    assert.ok(adminId, "AdminAccount admin1 should exist");

    const ok = execSql(`
      INSERT INTO "admin_audit_logs" ("actor_admin_id", "action", "target_type", "target_id", "created_at")
      VALUES (${adminId}, 'login', 'admin_account', '${adminId}', CURRENT_TIMESTAMP)
    `);
    assert.ok(ok, "AdminAuditLog should be inserted");

    const rows = runSqlRows(`SELECT action, target_type FROM "admin_audit_logs" WHERE actor_admin_id = ${adminId}`);
    assert.equal(rows.length, 1, "AdminAuditLog should exist");
    assert.equal(rows[0][0], "login", "action should be login");
    assert.equal(rows[0][1], "admin_account", "target_type should be admin_account");
  });

  it("should have NULLed existing reviewer_id values (no auto-conversion)", () => {
    const count = runSql(`SELECT count(*) FROM "review_items" WHERE id IN (1, 2) AND reviewer_id IS NULL`);
    assert.equal(count, "2", "Pre-migration reviewer_ids should be NULLed (no auto-conversion)");
  });

  it("should preserve review_decisions audit metadata (reviewerRole, evidenceFingerprint)", () => {
    const rows = runSqlRows(`SELECT id, reviewer_role, evidence_fingerprint FROM "review_decisions" WHERE id IN (1, 2) ORDER BY id`);
    assert.equal(rows.length, 2, "Pre-migration decisions should be preserved");

    const d1 = rows.find(r => r[0] === "1");
    const d2 = rows.find(r => r[0] === "2");
    assert.ok(d1 && d2, "Both decisions should exist");

    assert.equal(d1![1], "admin", "Decision 1 reviewer_role retained");
    assert.equal(d1![2], "fp_seed_001", "Decision 1 evidenceFingerprint retained");
    assert.equal(d2![1], "admin", "Decision 2 reviewer_role retained");
    assert.equal(d2![2], "fp_seed_002", "Decision 2 evidenceFingerprint retained");

    const nullCount = runSql(`SELECT count(*) FROM "review_decisions" WHERE id IN (1, 2) AND reviewer_id IS NULL`);
    assert.equal(nullCount, "2", "reviewer_id should be NULLed for both decisions");
  });

  it("should allow new ReviewItem with reviewer_id pointing to AdminAccount", () => {
    const adminId = runSql(`SELECT id FROM "admin_accounts" WHERE username = 'admin1' LIMIT 1`);
    assert.ok(adminId, "AdminAccount admin1 should exist");

    const ok = execSql(`
      INSERT INTO "review_items" ("type", "title", "status", "reviewer_id", "updated_at")
      VALUES ('general', 'Post-migration review item', 'pending', ${adminId}, CURRENT_TIMESTAMP)
    `);
    assert.ok(ok, "New ReviewItem with admin reviewer should be inserted");

    const rows = runSqlRows(`SELECT reviewer_id FROM "review_items" WHERE title = 'Post-migration review item'`);
    assert.equal(rows.length, 1, "New ReviewItem should exist");
    assert.equal(rows[0][0], adminId, "reviewer_id should point to AdminAccount");
  });

  it("should reject ReviewItem with reviewer_id pointing to non-existent AdminAccount", () => {
    const ok = execSql(`
      INSERT INTO "review_items" ("type", "title", "status", "reviewer_id", "updated_at")
      VALUES ('general', 'Invalid reviewer test', 'pending', 99999999, CURRENT_TIMESTAMP)
    `);
    assert.equal(ok, false, "FK constraint should reject non-existent admin_accounts id");
  });

  it("should allow user with NULL email (transitional: pre-cleanup)", () => {
    const ok = execSql(`
      INSERT INTO "users" ("display_name", "role", "is_active", "updated_at")
      VALUES ('Null Email User', 'user', true, CURRENT_TIMESTAMP)
    `);
    assert.ok(ok, "User with NULL email should be insertable (transitional)");

    const nullCount = runSql(`SELECT count(*) FROM "users" WHERE display_name = 'Null Email User' AND email IS NULL`);
    assert.equal(nullCount, "1", "Email should be NULL");
  });
});
