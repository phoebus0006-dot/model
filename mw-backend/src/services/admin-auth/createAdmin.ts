// Core logic for creating a Guanli admin account.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §3.5.
//
// This module is intentionally separated from the interactive CLI
// (scripts/admin/create-admin.ts) so the logic can be unit-tested with a mock
// PrismaClient and so the "no password output" guarantee can be asserted
// deterministically.
//
// Security requirements (contract §3.5):
//   - No default password (caller must supply one).
//   - Never print/log the password.
//   - Never create the hardcoded admin/admin account.
//   - Never overwrite an existing username (reject duplicates).
//   - role must be one of: admin, reviewer, operator.
//   - Write an AdminAuditLog entry (action=create_admin).

import { PrismaClient, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  normalizeUsername,
  normalizeAdminRole,
  VALID_ADMIN_ROLES,
  ADMIN_BCRYPT_COST,
} from "../../plugins/admin-auth/constants.js";
import { writeAdminAudit, AUDIT_CREATE_ADMIN, TARGET_ADMIN } from "../../plugins/admin-auth/audit.js";

export interface CreateAdminInput {
  username: string;
  displayName: string;
  role: string;
  password: string;
}

export interface CreateAdminResult {
  id: string;
  username: string;
  normalizedUsername: string;
  displayName: string;
  role: string;
}

export interface CreateAdminOptions {
  /**
   * Output sink. Defaults to console.log. Tests pass a capturing sink so they
   * can assert the password never appears in any emitted message.
   */
  log?: (msg: string) => void;
}

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

function validatePassword(password: string): string[] {
  const issues: string[] = [];
  if (password.length < PASSWORD_MIN) issues.push(`at least ${PASSWORD_MIN} characters`);
  if (password.length > PASSWORD_MAX) issues.push(`at most ${PASSWORD_MAX} characters`);
  if (!/[A-Z]/.test(password)) issues.push("at least 1 uppercase letter");
  if (!/[a-z]/.test(password)) issues.push("at least 1 lowercase letter");
  if (!/[^A-Za-z0-9]/.test(password)) issues.push("at least 1 special character");
  return issues;
}

/**
 * Validate and create an AdminAccount. Throws on any validation failure or
 * duplicate. NEVER returns or logs the password.
 */
export async function createAdmin(
  prisma: PrismaClient,
  input: CreateAdminInput,
  opts: CreateAdminOptions = {},
): Promise<CreateAdminResult> {
  const log = opts.log ?? ((m: string) => console.log(m));

  const username = String(input.username ?? "").trim();
  const displayName = String(input.displayName ?? "").trim();
  const roleRaw = String(input.role ?? "").trim();
  const password = String(input.password ?? "");

  if (!username) throw new Error("username is required");
  if (username.length > 100) throw new Error("username must be at most 100 characters");
  if (!displayName) throw new Error("displayName is required");
  if (displayName.length > 100) throw new Error("displayName must be at most 100 characters");
  if (!password) throw new Error("password is required (no default password is provided)");

  const role = normalizeAdminRole(roleRaw);
  if (!role) {
    throw new Error(`invalid role "${roleRaw}"; must be one of: ${VALID_ADMIN_ROLES.join(", ")}`);
  }

  // Reject the classic hardcoded admin/admin account (contract §3.5).
  // Checked BEFORE password strength so the specific prohibition is surfaced,
  // not masked by the generic "too weak" error.
  const normalizedUsername = normalizeUsername(username);
  if (normalizedUsername === "admin" && password === "admin") {
    throw new Error("refusing to create the hardcoded admin/admin account");
  }

  const pwIssues = validatePassword(password);
  if (pwIssues.length > 0) {
    throw new Error(`password is too weak: ${pwIssues.join(", ")}`);
  }

  // Reject duplicates. We check first (clear error) AND rely on the DB unique
  // constraint (Prisma P2002) as a race-safety net.
  const existing = await prisma.adminAccount.findUnique({
    where: { normalizedUsername },
    select: { id: true },
  });
  if (existing) {
    throw new Error(`an admin with username "${username}" already exists (refusing to overwrite)`);
  }

  const passwordHash = await bcrypt.hash(password, ADMIN_BCRYPT_COST);

  let created;
  try {
    created = await prisma.adminAccount.create({
      data: {
        username,
        normalizedUsername,
        passwordHash,
        displayName,
        role,
        isActive: true,
        sessionVersion: 0,
      },
      select: { id: true, username: true, normalizedUsername: true, displayName: true, role: true },
    });
  } catch (err) {
    // Prisma unique-constraint violation → friendly duplicate message.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new Error(`an admin with username "${username}" already exists (refusing to overwrite)`);
    }
    throw err;
  }

  // Audit log: the new admin is its own actor (self-creation). This satisfies
  // the NOT NULL actorAdminId FK because the AdminAccount row now exists.
  await writeAdminAudit(prisma, {
    actorAdminId: created.id,
    action: AUDIT_CREATE_ADMIN,
    targetType: TARGET_ADMIN,
    targetId: created.id.toString(),
    requestId: null,
    ip: null,
    userAgent: null,
  });

  const result: CreateAdminResult = {
    id: created.id.toString(),
    username: created.username,
    normalizedUsername: created.normalizedUsername,
    displayName: created.displayName,
    role: created.role,
  };

  // Intentionally does NOT include the password.
  log(`Created admin "${result.username}" (role=${result.role}, id=${result.id})`);
  return result;
}
