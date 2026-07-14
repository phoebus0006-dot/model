/**
 * Migration test: duplicate email conflict detection
 *
 * Verifies that post-migration unique constraints correctly reject duplicate
 * emails and duplicate normalized emails, while allowing multiple NULL emails
 * (transitional, per AUTH_ACCOUNT_CONTRACT.md §7).
 *
 * Per Wave 1 Agent Contract task #17: "duplicate-email-conflict test"
 *
 * Requires:
 *   DATABASE_URL — disposable PostgreSQL connection string (NOT production)
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL || "";
const DB_NAME = DATABASE_URL.split("/").pop() || "mw_test_dupemail";
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

describe("Duplicate email conflict detection", { timeout: 180000 }, () => {
  before(() => {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL must be set to a disposable PostgreSQL instance");
    }
    execSync("npx prisma migrate deploy", {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL },
      stdio: "pipe",
      timeout: 100000,
    });
  });

  it("should reject duplicate email on insert", () => {
    const ok1 = execSql(`
      INSERT INTO "users" ("email", "normalized_email", "display_name", "role", "is_active", "updated_at", "session_version")
      VALUES ('alice@example.com', 'alice@example.com', 'Alice', 'user', true, CURRENT_TIMESTAMP, 0)
    `);
    assert.ok(ok1, "First user with email should be inserted");

    const ok2 = execSql(`
      INSERT INTO "users" ("email", "normalized_email", "display_name", "role", "is_active", "updated_at", "session_version")
      VALUES ('alice@example.com', 'alice@example.com', 'Alice Dup', 'user', true, CURRENT_TIMESTAMP, 0)
    `);
    assert.equal(ok2, false, "Duplicate email should be rejected by unique constraint");
  });

  it("should reject duplicate normalized_email with different email", () => {
    const ok1 = execSql(`
      INSERT INTO "users" ("email", "normalized_email", "display_name", "role", "is_active", "updated_at", "session_version")
      VALUES ('bob@example.com', 'bob@example.com', 'Bob', 'user', true, CURRENT_TIMESTAMP, 0)
    `);
    assert.ok(ok1, "First user should be inserted");

    const ok2 = execSql(`
      INSERT INTO "users" ("email", "normalized_email", "display_name", "role", "is_active", "updated_at", "session_version")
      VALUES ('bob@other.com', 'bob@example.com', 'Bob Dup', 'user', true, CURRENT_TIMESTAMP, 0)
    `);
    assert.equal(ok2, false, "Duplicate normalized_email should be rejected");
  });

  it("should allow multiple users with NULL email (transitional)", () => {
    const ok1 = execSql(`
      INSERT INTO "users" ("display_name", "role", "is_active", "updated_at")
      VALUES ('Null Email User A', 'user', true, CURRENT_TIMESTAMP)
    `);
    assert.ok(ok1, "First NULL email user should be inserted");

    const ok2 = execSql(`
      INSERT INTO "users" ("display_name", "role", "is_active", "updated_at")
      VALUES ('Null Email User B', 'user', true, CURRENT_TIMESTAMP)
    `);
    assert.ok(ok2, "Second NULL email user should be inserted (multiple NULLs allowed)");
  });

  it("should detect zero duplicate emails via SQL query", () => {
    // This is the query pattern used to detect duplicates before making email NOT NULL
    const dupCount = runSql(`
      SELECT count(*) FROM (
        SELECT lower(email) AS norm_email, count(*) AS cnt
        FROM "users"
        WHERE email IS NOT NULL
        GROUP BY lower(email)
        HAVING count(*) > 1
      ) dups
    `);
    assert.equal(dupCount, "0", "No duplicate emails should exist (constraint enforced)");
  });

  it("should have unique index on email column", () => {
    const idx = runSql(`SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexname = 'users_email_key'`);
    assert.ok(idx.includes("users_email_key"), "users_email_key unique index should exist");
  });

  it("should have unique index on normalized_email column", () => {
    const idx = runSql(`SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexname = 'users_normalized_email_key'`);
    assert.ok(idx.includes("users_normalized_email_key"), "users_normalized_email_key unique index should exist");
  });
});
