// Shared types for the Guanli admin-auth subsystem.
//
// Production code uses the real `PrismaClient` type (via `app.prisma`, which is
// declared on FastifyInstance by src/plugins/prisma.ts). This keeps full schema
// type safety — no `prisma as any` is used to bypass field types (contract §4
// prohibition #8). Tests inject lightweight mocks through `(app as any).prisma`
// in test files (which are outside the `tsc` `src` scope).

import type { AdminAccount } from "@prisma/client";

/** The admin identity attached to `req.admin` by the guard. */
export interface AdminIdentity {
  /** Decimal string — preserves full BigInt precision (AdminAccount.id is BigInt). */
  adminId: string;
  username: string;
  displayName: string;
  /** Current DB role — never sourced from the JWT for authorization. */
  role: string;
  sessionVersion: number;
}

/** Fields selected from AdminAccount by the guard + routes. */
export type AdminAccountRow = Pick<
  AdminAccount,
  "id" | "username" | "displayName" | "role" | "isActive" | "sessionVersion"
>;

/** Shape of the data passed to prisma.adminAuditLog.create({ data }). */
export interface AdminAuditLogCreateData {
  actorAdminId: bigint;
  action: string;
  targetType: string;
  targetId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}
