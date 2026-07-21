// Guanli admin audit logging.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §3.3 + §6.
//
// Every sensitive admin action writes a row to AdminAuditLog. The schema
// (prisma/schema.prisma) defines these columns ONLY:
//   actorAdminId (BigInt, NOT NULL, FK -> admin_accounts.id)
//   action       (String)
//   targetType   (String)
//   targetId     (String?)
//   requestId    (String?)
//   ip           (String?)
//   userAgent    (String?)
//   createdAt    (auto)
//
// IMPORTANT: there is NO `metadata` column on AdminAuditLog. Per the task
// contract, we MUST NOT fabricate a non-existent field with `as any`. All
// context must therefore be carried in the existing string columns. Sensitive
// data (passwords, raw tokens) is never written.
//
// Because `actorAdminId` is NOT NULL with a FK constraint, audit entries can
// only be written when a real AdminAccount row exists to attribute the action
// to. For `login_failed` against a username that does not map to any
// AdminAccount, no audit row can be written (FK violation) — callers must skip
// the audit write in that case. For `login_failed` against an existing admin
// (wrong password / disabled), the audit row IS written with that admin's id.

import type { PrismaClient } from "@prisma/client";
import type { AdminAuditLogCreateData } from "./types.js";

// ─── Audit action vocabulary (contract §3.3) ─────────────────────────────────
export const AUDIT_LOGIN_SUCCESS = "login_success";
export const AUDIT_LOGIN_FAILED = "login_failed";
export const AUDIT_LOGOUT = "logout";
export const AUDIT_PASSWORD_CHANGED = "password_changed";
export const AUDIT_CREATE_ADMIN = "create_admin";
export const AUDIT_ACCOUNT_DISABLED = "account_disabled";
/** Best-effort security log; written when identifiable (contract §3.3). */
export const AUDIT_TOKEN_REJECTED = "token_rejected";

// ─── Target type vocabulary ──────────────────────────────────────────────────
export const TARGET_ADMIN = "admin";

/**
 * Write an AdminAuditLog row. Best-effort: a failure to write the audit row
 * is logged but does NOT throw, so it cannot break the request flow. Callers
 * that need to assert the row was written (e.g. tests) should inspect the DB.
 *
 * The PrismaClient argument is the real client in production; tests pass a
 * mock. No `as any` is used on the prisma instance here.
 */
export async function writeAdminAudit(
  prisma: PrismaClient,
  input: AdminAuditLogCreateData,
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorAdminId: input.actorAdminId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        requestId: input.requestId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch (err) {
    // Audit logging must not take down the auth flow. Surface the error to the
    // server log for operators; the request continues.
    // eslint-disable-next-line no-console
    console.error("[admin-audit] failed to write AdminAuditLog:", err);
  }
}
