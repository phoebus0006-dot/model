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
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createDbHelpers } from "./helpers";

const { setup, runSql, execSql, execPrisma } = createDbHelpers("mw_test_malformed");

describe("Malformed email handling", { timeout: 180000 }, () => {
  before(() => {
    setup();
    execPrisma("migrate deploy");
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