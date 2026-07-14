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
    execSync("npx prisma migrate deploy", { cwd: process.cwd(), env: { ...process.env, DATABASE_URL }, stdio: "pipe", timeout: 100000 });
  });

  it("should create users table with email fields", () => {
    const rows = runSqlRows(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('email','normalized_email','email_verified_at','email_verify_token_hash','email_verify_expires_at','password_reset_token_hash','password_reset_expires_at','session_version') ORDER BY column_name`);
    const m = new Map(rows.map(r => [r[0], { dt: r[1], nu: r[2] }]));
    for (const c of ["email","normalized_email","email_verified_at","email_verify_token_hash","email_verify_expires_at","password_reset_token_hash","password_reset_expires_at","session_version"]) assert.ok(m.has(c), `users.${c} should exist`);
    assert.equal(m.get("session_version")!.nu, "NO", "session_version must be NOT NULL");
    assert.equal(m.get("session_version")!.dt, "integer", "session_version must be integer");
  });

  it("should have unique indexes on email and normalized_email", () => {
    const r = runSql(`SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexname IN ('users_email_key', 'users_normalized_email_key')`);
    assert.ok(r.includes("users_email_key"), "users_email_key should exist");
    assert.ok(r.includes("users_normalized_email_key"), "users_normalized_email_key should exist");
  });

  it("should create admin_accounts table with correct structure", () => {
    const rows = runSqlRows(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'admin_accounts' ORDER BY ordinal_position`);
    const cols = new Set(rows.map(r => r[0]));
    for (const c of ["id","username","normalized_username","password_hash","display_name","role","is_active","session_version","last_login_at","password_changed_at","created_at","updated_at"]) assert.ok(cols.has(c), `admin_accounts.${c} should exist`);
    assert.equal(rows.find(r => r[0] === "username")![1], "NO", "username must be NOT NULL");
  });

  it("should have unique indexes on admin_accounts username and normalized_username", () => {
    const r = runSql(`SELECT indexname FROM pg_indexes WHERE tablename = 'admin_accounts'`);
    assert.ok(r.includes("admin_accounts_username_key"), "username unique index should exist");
    assert.ok(r.includes("admin_accounts_normalized_username_key"), "normalized_username unique index should exist");
  });

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

  it("should have all existing review/crawler tables preserved", () => {
    const r = runSql(`SELECT string_agg(table_name, ',') FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    for (const t of ["review_items","review_decisions","crawler_jobs","crawler_job_events","figures","users","admin_accounts","admin_audit_logs"]) assert.ok(r.includes(t), `Table ${t} should exist`);
  });
});