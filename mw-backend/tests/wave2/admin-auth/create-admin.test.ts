// createAdmin service tests: validates the core logic used by the
// `npm run admin:create` CLI (scripts/admin/create-admin.ts).
//
// Contract: AUTH_ACCOUNT_CONTRACT.md §3.5.
//   - No default password (caller must supply one).
//   - Never print/log the password.
//   - Never create the hardcoded admin/admin account.
//   - Never overwrite an existing username (reject duplicates).
//   - role must be one of: admin, reviewer, operator.
//   - Write an AdminAuditLog entry (action=create_admin).
//
// Run: npx tsx --test tests/wave2/admin-auth/create-admin.test.ts

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makePrismaMock, type PrismaMock } from "./helpers.js";
import { createAdmin } from "../../../src/services/admin-auth/createAdmin.js";

describe("createAdmin: success cases", () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  test("creates an admin with valid input and returns the result (no password)", async () => {
    const result = await createAdmin(prisma, {
      username: "newadmin",
      displayName: "New Admin",
      role: "admin",
      password: "StrongPass!123",
    });
    assert.equal(result.username, "newadmin");
    assert.equal(result.normalizedUsername, "newadmin");
    assert.equal(result.displayName, "New Admin");
    assert.equal(result.role, "admin");
    assert.ok(result.id);
    // Result must NOT contain the password.
    assert.equal((result as Record<string, unknown>).password, undefined);
    assert.equal((result as Record<string, unknown>).passwordHash, undefined);
  });

  test("creates a reviewer and an operator", async () => {
    const rev = await createAdmin(prisma, {
      username: "reviewer1",
      displayName: "Reviewer One",
      role: "reviewer",
      password: "ReviewerPass!1",
    });
    assert.equal(rev.role, "reviewer");

    const op = await createAdmin(prisma, {
      username: "operator1",
      displayName: "Operator One",
      role: "operator",
      password: "OperatorPass!1",
    });
    assert.equal(op.role, "operator");
  });

  test("username is normalized (trim + lowercase) for storage", async () => {
    const result = await createAdmin(prisma, {
      username: "  MixedCase  ",
      displayName: "Display",
      role: "admin",
      password: "StrongPass!123",
    });
    assert.equal(result.username, "MixedCase"); // original trimmed
    assert.equal(result.normalizedUsername, "mixedcase"); // normalized
  });

  test("password is hashed with bcrypt (not stored in plaintext)", async () => {
    const password = "MySecretPass!123";
    await createAdmin(prisma, {
      username: "hashcheck",
      displayName: "Hash Check",
      role: "admin",
      password,
    });
    // Find the stored row and verify the hash is NOT the plaintext.
    let stored = null;
    for (const row of prisma._admins.values()) {
      if (row.username === "hashcheck") {
        stored = row;
        break;
      }
    }
    assert.ok(stored, "admin row should exist");
    assert.notEqual(stored.passwordHash, password);
    assert.ok(stored.passwordHash.startsWith("$2"), "should be a bcrypt hash");
  });

  test("writes a create_admin audit log entry", async () => {
    await createAdmin(prisma, {
      username: "audited",
      displayName: "Audited",
      role: "admin",
      password: "StrongPass!123",
    });
    const createLogs = prisma._auditLogs.filter((l) => l.action === "create_admin");
    assert.equal(createLogs.length, 1);
  });
});

describe("createAdmin: rejection cases", () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  test("rejects the hardcoded admin/admin account", async () => {
    await assert.rejects(
      () => createAdmin(prisma, { username: "admin", displayName: "Admin", role: "admin", password: "admin" }),
      /admin\/admin/,
    );
    // No row should have been created.
    assert.equal(prisma._admins.size, 0);
  });

  test("rejects duplicate username (case-insensitive via normalizedUsername)", async () => {
    await createAdmin(prisma, {
      username: "Admin",
      displayName: "First Admin",
      role: "admin",
      password: "StrongPass!123",
    });
    // A second create with a different-case username that normalizes to the
    // same key must be rejected.
    await assert.rejects(
      () => createAdmin(prisma, { username: "ADMIN", displayName: "Second", role: "admin", password: "AnotherPass!1" }),
      /already exists/,
    );
    assert.equal(prisma._admins.size, 1);
  });

  test("rejects invalid role", async () => {
    await assert.rejects(
      () => createAdmin(prisma, { username: "badrole", displayName: "Bad", role: "superuser", password: "StrongPass!123" }),
      /invalid role/,
    );
  });

  test("rejects weak password (too short)", async () => {
    await assert.rejects(
      () => createAdmin(prisma, { username: "weakpw", displayName: "Weak", role: "admin", password: "Short1!" }),
      /too weak/,
    );
  });

  test("rejects weak password (no uppercase)", async () => {
    await assert.rejects(
      () => createAdmin(prisma, { username: "weakpw2", displayName: "Weak", role: "admin", password: "alllowercase!1" }),
      /too weak/,
    );
  });

  test("rejects weak password (no special char)", async () => {
    await assert.rejects(
      () => createAdmin(prisma, { username: "weakpw3", displayName: "Weak", role: "admin", password: "NoSpecialChar1" }),
      /too weak/,
    );
  });

  test("rejects empty password (no default password is provided)", async () => {
    await assert.rejects(
      () => createAdmin(prisma, { username: "nopw", displayName: "NoPw", role: "admin", password: "" }),
      /password is required/,
    );
  });

  test("rejects empty username", async () => {
    await assert.rejects(
      () => createAdmin(prisma, { username: "  ", displayName: "Empty", role: "admin", password: "StrongPass!123" }),
      /username is required/,
    );
  });

  test("rejects empty displayName", async () => {
    await assert.rejects(
      () => createAdmin(prisma, { username: "nodisplay", displayName: "", role: "admin", password: "StrongPass!123" }),
      /displayName is required/,
    );
  });
});

describe("createAdmin: no password output guarantee", () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  test("the log output NEVER contains the password", async () => {
    const captured: string[] = [];
    const password = "NeverLogThis!123";
    await createAdmin(
      prisma,
      { username: "nolog", displayName: "No Log", role: "admin", password },
      { log: (msg) => captured.push(msg) },
    );
    for (const line of captured) {
      assert.ok(!line.includes(password), `password leaked in log: "${line}"`);
    }
  });

  test("the log output contains the username and role (for operator confirmation)", async () => {
    const captured: string[] = [];
    await createAdmin(
      prisma,
      { username: "visible", displayName: "Visible", role: "reviewer", password: "SomePass!123" },
      { log: (msg) => captured.push(msg) },
    );
    const combined = captured.join("\n");
    assert.ok(combined.includes("visible"), "log should mention the username");
    assert.ok(combined.includes("reviewer"), "log should mention the role");
  });
});
