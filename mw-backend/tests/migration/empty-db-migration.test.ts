/**
 * Empty database migration test.
 *
 * Verifies that `prisma migrate deploy` succeeds on an empty database, creates
 * all expected tables/columns/constraints/indexes, and that the migration
 * history is correctly recorded in `_prisma_migrations`.
 *
 * Coverage: empty database, constraint verification, migration history verification.
 *
 * Requires:
 *   DATABASE_URL — disposable PostgreSQL connection string (NOT production)
 *   PSQL at %TEMP%\pg17\pgsql\bin\psql.exe, port 15432, user testuser
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL || "";
const DB_NAME = DATABASE_URL.split("/").pop() || "mw_test_empty";
const PSQL = path.join(process.env.TEMP || "", "pg17", "pgsql", "bin", "psql.exe");

function runSql(sql: string): string {
  try {
    return execSync(`"${PSQL}" -p 15432 -U testuser -d ${DB_NAME} -t -A -F "\t"`, {
      encoding: "utf-8", timeout: 30000, stdio: ["pipe","pipe","pipe"], input: sql,
    }).trim().replace(/\r/g, "");
  } catch (e: any) { return e.stdout ? e.stdout.trim().replace(/\r/g, "") : ""; }
}

function runSqlRows(sql: string): string[][] {
  const r = runSql(sql); if (!r) return []; return r.split("\n").map(l => l.split("\t"));
}

describe("Empty database migration", { timeout: 120000 }, () => {
  before(() => {
    if (!DATABASE_URL) throw new Error("DATABASE_URL must be set");
    // Ensure clean database
    execSync(`"${PSQL}" -p 15432 -U testuser -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME};"`, { stdio: "pipe", timeout: 15000 });
    execSync(`"${PSQL}" -p 15432 -U testuser -d postgres -c "CREATE DATABASE ${DB_NAME};"`, { stdio: "pipe", timeout: 15000 });
    execSync("npx prisma migrate deploy", { cwd: process.cwd(), env: { ...process.env, DATABASE_URL }, stdio: "pipe", timeout: 100000 });
  });

  // ─── Table existence ──────────────────────────────────────────────────────
  it("should create all expected tables", () => {
    const r = runSql(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    const tables = r.split(",");
    for (const t of [
      "figures","figure_localized","figure_releases","series","characters",
      "manufacturers","sculptors","categories","revisions","figure_images",
      "figure_category","figure_sculptor","figure_character","users",
      "favorite_groups","favorites","figure_likes","figure_comments",
      "entity_mapping","redirect_map",
      "crawler_jobs","review_items","review_decisions","crawler_job_events",
      "admin_accounts","admin_audit_logs","_reviewer_fk_migration_audit",
    ]) assert.ok(tables.includes(t), `Table ${t} should exist`);
  });

  // ─── Column type + nullability verification (task #5) ─────────────────────
  it("should have users.email fields with correct types and nullability", () => {
    const rows = runSqlRows(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('email','normalized_email','email_verified_at','email_verify_token_hash','email_verify_expires_at','password_reset_token_hash','password_reset_expires_at','session_version') ORDER BY column_name`);
    const m = new Map(rows.map(r => [r[0], { dt: r[1], nu: r[2], def: r[3] }]));
    for (const c of ["email","normalized_email","email_verified_at","email_verify_token_hash","email_verify_expires_at","password_reset_token_hash","password_reset_expires_at","session_version"]) assert.ok(m.has(c), `users.${c} should exist`);
    assert.equal(m.get("session_version")!.nu, "NO", "session_version must be NOT NULL");
    assert.equal(m.get("session_version")!.dt, "integer", "session_version must be integer");
    assert.ok(m.get("session_version")!.def?.includes("0"), "session_version default must be 0");
    assert.equal(m.get("email")!.dt, "text", "email must be TEXT");
    assert.equal(m.get("email")!.nu, "YES", "email must be nullable (transitional)");
    assert.equal(m.get("normalized_email")!.dt, "text", "normalized_email must be TEXT");
    assert.equal(m.get("normalized_email")!.nu, "YES", "normalized_email must be nullable (transitional)");
    assert.equal(m.get("email_verified_at")!.dt, "timestamp without time zone", "email_verified_at must be TIMESTAMP");
  });

  // ─── Unique constraint verification (task #5) ─────────────────────────────
  it("should have unique indexes on email and normalized_email", () => {
    const r = runSql(`SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexname IN ('users_email_key', 'users_normalized_email_key')`);
    assert.ok(r.includes("users_email_key"), "users_email_key should exist");
    assert.ok(r.includes("users_normalized_email_key"), "users_normalized_email_key should exist");
  });

  it("should have unique indexes on admin_accounts username and normalized_username", () => {
    const r = runSql(`SELECT indexname FROM pg_indexes WHERE tablename = 'admin_accounts'`);
    assert.ok(r.includes("admin_accounts_username_key"), "username unique index should exist");
    assert.ok(r.includes("admin_accounts_normalized_username_key"), "normalized_username unique index should exist");
  });

  // ─── FK verification (task #5) ────────────────────────────────────────────
  it("should create admin_audit_logs table with FK to admin_accounts", () => {
    const r = runSql(`SELECT ccu.table_name FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.table_name = 'admin_audit_logs' AND tc.constraint_type = 'FOREIGN KEY' AND tc.constraint_name = 'admin_audit_logs_actor_admin_id_fkey'`);
    assert.ok(r.includes("admin_accounts"), "admin_audit_logs FK should point to admin_accounts");
  });

  it("should have review_items.reviewer_id FK pointing to admin_accounts", () => {
    const r = runSql(`SELECT ccu.table_name FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.table_name = 'review_items' AND tc.constraint_type = 'FOREIGN KEY' AND tc.constraint_name = 'review_items_reviewer_id_fkey'`);
    assert.equal(r.trim(), "admin_accounts", "review_items.reviewer_id FK must point to admin_accounts");
  });

  it("should have review_decisions.reviewer_id FK pointing to admin_accounts", () => {
    const r = runSql(`SELECT ccu.table_name FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.table_name = 'review_decisions' AND tc.constraint_type = 'FOREIGN KEY' AND tc.constraint_name = 'review_decisions_reviewer_id_fkey'`);
    assert.equal(r.trim(), "admin_accounts", "review_decisions.reviewer_id FK must point to admin_accounts");
  });

  // ─── Index verification (task #5) ─────────────────────────────────────────
  it("should have admin_audit_logs composite index on (actor_admin_id, created_at)", () => {
    const r = runSql(`SELECT indexname FROM pg_indexes WHERE tablename = 'admin_audit_logs' AND indexname = 'admin_audit_logs_actor_admin_id_created_at_idx'`);
    assert.ok(r.includes("admin_audit_logs_actor_admin_id_created_at_idx"), "composite index should exist");
  });

  // ─── Reviewer audit table verification ────────────────────────────────────
  it("should create _reviewer_fk_migration_audit table", () => {
    const rows = runSqlRows(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '_reviewer_fk_migration_audit' ORDER BY ordinal_position`);
    const cols = new Map(rows.map(r => [r[0], r[1]]));
    for (const c of ["id","source_table","record_id","original_reviewer_id","migration_name","nullified_at"]) {
      assert.ok(cols.has(c), `_reviewer_fk_migration_audit.${c} should exist`);
    }
  });

  // ─── Migration history verification (task: migration history verification) ─
  it("should have all 4 migrations recorded in _prisma_migrations", () => {
    const rows = runSqlRows(`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name`);
    assert.equal(rows.length, 4, `Expected 4 migrations, got ${rows.length}`);
    const names = rows.map(r => r[0]);
    for (const m of [
      "20260712000000_baseline_tables",
      "20260713000000_phase12_review_workflow",
      "20260713000001_review_storage_agent_a",
      "20260714000000_account_schema",
    ]) assert.ok(names.includes(m), `Migration ${m} should be recorded`);
    for (const r of rows) {
      assert.ok(r[1], `Migration ${r[0]} should have finished_at set`);
      assert.ok(!r[2], `Migration ${r[0]} should not be rolled back`);
    }
  });

  it("should have migration checksums recorded", () => {
    const rows = runSqlRows(`SELECT migration_name, checksum FROM "_prisma_migrations" ORDER BY migration_name`);
    for (const r of rows) {
      assert.ok(r[1] && r[1].length > 0, `Migration ${r[0]} should have a non-empty checksum`);
    }
  });
});
