/**
 * Migration test: malformed email handling.
 *
 * Verifies that the migration allows users with malformed emails to be inserted
 * (email is TEXT, no DB-level format validation — that is an application-layer
 * concern), that unique constraints still function, and that NULL emails are
 * allowed during the transitional period.
 *
 * Coverage: malformed email.
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
const DB_NAME = DATABASE_URL.split("/").pop() || "mw_test_malformed";
const PSQL = path.join(process.env.TEMP || "", "pg17", "pgsql", "bin", "psql.exe");

function runSql(sql: string): string {
  try {
    return execSync(`"${PSQL}" -p 15432 -U testuser -d ${DB_NAME} -t -A -F "\t"`, {
      encoding: "utf-8", timeout: 30000, stdio: ["pipe","pipe","pipe"], input: sql,
    }).trim().replace(/\r/g, "");
  } catch (e: any) { return e.stdout ? e.stdout.trim().replace(/\r/g, "") : ""; }
}

function execSql(sql: string): boolean {
  try {
    execSync(`"${PSQL}" -p 15432 -U testuser -d ${DB_NAME} -v ON_ERROR_STOP=1`, {
      encoding: "utf-8", timeout: 30000, stdio: ["pipe","pipe","pipe"], input: sql,
    });
    return true;
  } catch (e) { return false; }
}

describe("Malformed email handling", { timeout: 180000 }, () => {
  before(() => {
    if (!DATABASE_URL) throw new Error("DATABASE_URL must be set");
    execSync(`"${PSQL}" -p 15432 -U testuser -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME};"`, { stdio: "pipe", timeout: 15000 });
    execSync(`"${PSQL}" -p 15432 -U testuser -d postgres -c "CREATE DATABASE ${DB_NAME};"`, { stdio: "pipe", timeout: 15000 });
    execSync("npx prisma migrate deploy", { cwd: process.cwd(), env: { ...process.env, DATABASE_URL }, stdio: "pipe", timeout: 100000 });
  });

  it("should allow user with malformed email (DB has no format constraint)", () => {
    const ok = execSql(`
      INSERT INTO "users" ("email", "normalized_email", "display_name", "role", "is_active", "updated_at", "session_version")
      VALUES ('not-an-email', 'not-an-email', 'Malformed User', 'user', true, CURRENT_TIMESTAMP, 0)
    `);
    assert.ok(ok, "Malformed email should be insertable (format validation is application-layer)");
  });

  it("should allow user with empty-string email components", () => {
    const ok = execSql(`
      INSERT INTO "users" ("email", "normalized_email", "display_name", "role", "is_active", "updated_at", "session_version")
      VALUES ('@', '@', 'At Only', 'user', true, CURRENT_TIMESTAMP, 0)
    `);
    assert.ok(ok, "Malformed email '@' should be insertable at DB level");
  });

  it("should enforce unique constraint even on malformed emails", () => {
    // Insert a duplicate of the 'not-an-email' email from the first test
    const ok = execSql(`
      INSERT INTO "users" ("email", "normalized_email", "display_name", "role", "is_active", "updated_at", "session_version")
      VALUES ('not-an-email', 'not-an-email', 'Dup Malformed', 'user', true, CURRENT_TIMESTAMP, 0)
    `);
    assert.equal(ok, false, "Duplicate malformed email should be rejected by unique constraint");
  });

  it("should allow multiple users with NULL email", () => {
    const ok1 = execSql(`INSERT INTO "users" ("display_name", "role", "is_active", "updated_at") VALUES ('Null A', 'user', true, CURRENT_TIMESTAMP)`);
    const ok2 = execSql(`INSERT INTO "users" ("display_name", "role", "is_active", "updated_at") VALUES ('Null B', 'user', true, CURRENT_TIMESTAMP)`);
    assert.ok(ok1 && ok2, "Multiple NULL emails should be allowed (transitional)");
  });

  it("should have correct column type for email (TEXT, nullable)", () => {
    const rows = runSql(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email'`);
    const [dt, nu] = rows.split("\t");
    assert.equal(dt, "text", "email must be TEXT type");
    assert.equal(nu, "YES", "email must be nullable (transitional)");
  });
});
