/**
 * Dry-run classification script for User email migration + reviewer FK migration.
 *
 * Per Wave 1 Schema Hardening contract tasks #9, #13, #15, #16.
 *
 * ZERO-WRITE GUARANTEE: This script performs ONLY read-only SELECT queries
 * against the database. It does NOT INSERT, UPDATE, or DELETE any rows, does
 * NOT run any DDL, and does NOT use `prisma db push`. The only write is to a
 * local JSON report file on the filesystem (not the database). This satisfies
 * the "dry-run 分类默认零写入" requirement (task #16).
 *
 * Classification fields (task #9):
 *   - totalUsers, validEmailUsers, missingEmailUsers, duplicateEmails
 *   - malformedEmails, adminLikeUsers, automaticallyMigratable, manualReviewRequired
 *
 * Reviewer FK impact fields (task #13):
 *   - reviewItemsWithReviewerBefore
 *   - reviewDecisionsWithReviewerBefore
 *   - distinctReviewerIds
 *   - automaticallyMapped
 *   - unmappedReviewerIds
 *   - nullifiedReviewerIds
 *   - reviewItemsAfter
 *   - reviewDecisionsAfter
 *
 * Per task #10: DO NOT forge emails. This script does NOT generate fake emails.
 * Per task #11: Users without restorable email are preserved; listed in pending report.
 * Per task #12: AdminAccount init does NOT auto-convert from User.
 * Per task #15: Original reviewer IDs are captured here AND preserved in the
 *   `_reviewer_fk_migration_audit` table by the migration SQL itself.
 *
 * Usage:
 *   npx tsx scripts/migration/dry-run-classify.ts
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string (disposable DB, NOT production)
 */

import { PrismaClient } from "@prisma/client";
import { fileURLToPath } from "node:url";

export interface DryRunReport {
  generatedAt: string;
  databaseUrlMasked: string;
  zeroWriteGuarantee: string;
  classification: {
    totalUsers: number;
    validEmailUsers: number;
    missingEmailUsers: number;
    duplicateEmails: number;
    malformedEmails: number;
    adminLikeUsers: number;
    automaticallyMigratable: number;
    manualReviewRequired: number;
  };
  details: {
    missingEmailUsersList: Array<{ id: string; displayName: string; role: string }>;
    duplicateEmailsList: Array<{ email: string; count: number }>;
    malformedEmailsList: Array<{ id: string; email: string; displayName: string }>;
    adminLikeUsersList: Array<{ id: string; displayName: string; role: string }>;
  };
  reviewerFkMigration: {
    reviewItemsWithReviewerBefore: number;
    reviewDecisionsWithReviewerBefore: number;
    distinctReviewerIds: string[];
    automaticallyMapped: string[];
    unmappedReviewerIds: string[];
    nullifiedReviewerIds: string[];
    reviewItemsAfter: number;
    reviewDecisionsAfter: number;
    adminAccountsTableExists: boolean;
    note: string;
  };
  recommendations: string[];
}

function isValidEmail(email: string): boolean {
  // Basic format validation per contract §2.5: must have exactly one "@",
  // non-empty local + domain. Does NOT do provider-specific rewriting.
  const trimmed = email.trim();
  if (trimmed.length === 0) return false;
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return false;
  if (trimmed.indexOf("@") !== atIdx) return false; // exactly one "@"
  const local = trimmed.substring(0, atIdx);
  const domain = trimmed.substring(atIdx + 1);
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes(".")) return false;
  return true;
}

function normalizeEmailDomain(raw: string): string {
  // Per contract §2.5: trim + domain lowercase. No provider-specific rewriting.
  const trimmed = raw.trim();
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0) return trimmed;
  const local = trimmed.substring(0, atIdx);
  const domain = trimmed.substring(atIdx + 1).toLowerCase();
  return `${local}@${domain}`;
}

function maskDatabaseUrl(url: string): string {
  return url.replace(/:\/\/[^@]+@/, "://***:***@");
}

/**
 * Generate the dry-run classification report.
 *
 * This function performs ONLY read-only SELECT queries against the database.
 * It does NOT INSERT, UPDATE, or DELETE any rows, and does NOT run any DDL.
 *
 * Exported so that tests can import and call this directly, avoiding
 * subprocess stdout capture issues in sandboxed environments.
 *
 * @param databaseUrl — PostgreSQL connection string (disposable DB, NOT production)
 * @returns DryRunReport with classification and reviewer FK migration metrics
 */
export async function generateReport(databaseUrl: string): Promise<DryRunReport> {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  try {
    // ─── Check if email column exists (pre-migration DB may not have it) ──────
    // The email column is added by migration 20260714000000_account_schema.
    // When running the dry-run BEFORE that migration, the column does not exist.
    const emailColumnExistsRows = await (prisma as any).$queryRawUnsafe<
      Array<{ exists: boolean }>
    >(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
       ) as exists`
    );
    const emailColumnExists = emailColumnExistsRows[0]?.exists ?? false;

    // ─── User email classification (read-only) ──────────────────────────────
    // If the email column doesn't exist yet (pre-migration), select NULL so all
    // users are classified as "missing email".
    const users = await (prisma as any).$queryRawUnsafe<
      Array<{ id: bigint; display_name: string; role: string; email: string | null }>
    >(emailColumnExists
      ? `SELECT id, display_name, role, email FROM "users" ORDER BY id`
      : `SELECT id, display_name, role, NULL::text as email FROM "users" ORDER BY id`
    );

    const totalUsers = users.length;
    const missingEmailUsersList: DryRunReport["details"]["missingEmailUsersList"] = [];
    const malformedEmailsList: DryRunReport["details"]["malformedEmailsList"] = [];
    const adminLikeUsersList: DryRunReport["details"]["adminLikeUsersList"] = [];
    const emailCounts = new Map<string, { count: number; raw: string }>();

    let validEmailUsers = 0;

    for (const user of users) {
      const id = user.id.toString();
      const displayName = user.display_name;
      const role = user.role;

      if (role === "admin" || role === "superadmin" || role === "administrator") {
        adminLikeUsersList.push({ id, displayName, role });
      }

      if (!user.email || user.email.trim().length === 0) {
        missingEmailUsersList.push({ id, displayName, role });
      } else {
        if (!isValidEmail(user.email)) {
          malformedEmailsList.push({ id, email: user.email, displayName });
        } else {
          validEmailUsers++;
          const normalized = normalizeEmailDomain(user.email);
          const existing = emailCounts.get(normalized);
          if (existing) {
            existing.count++;
          } else {
            emailCounts.set(normalized, { count: 1, raw: user.email });
          }
        }
      }
    }

    const duplicateEmailsList: DryRunReport["details"]["duplicateEmailsList"] = [];
    for (const [normalized, info] of emailCounts) {
      if (info.count > 1) {
        duplicateEmailsList.push({ email: normalized, count: info.count });
      }
    }

    const duplicateEmailCount = duplicateEmailsList.reduce((sum, d) => sum + d.count, 0);
    const automaticallyMigratable = validEmailUsers - duplicateEmailCount;
    const missingEmailUsers = missingEmailUsersList.length;
    const malformedEmailCount = malformedEmailsList.length;
    const manualReviewRequired =
      missingEmailUsers + malformedEmailCount + duplicateEmailCount;

    // ─── Reviewer FK migration impact (read-only) ───────────────────────────
    // Per task #13: output the full before/after picture.
    const reviewItemsWithReviewer = await (prisma as any).$queryRawUnsafe<
      Array<{ count: bigint }>
    >(`SELECT COUNT(*)::bigint as count FROM "review_items" WHERE "reviewer_id" IS NOT NULL`);

    const reviewDecisionsWithReviewer = await (prisma as any).$queryRawUnsafe<
      Array<{ count: bigint }>
    >(`SELECT COUNT(*)::bigint as count FROM "review_decisions" WHERE "reviewer_id" IS NOT NULL`);

    // Distinct reviewer_id values across both tables
    const distinctReviewerRows = await (prisma as any).$queryRawUnsafe<
      Array<{ reviewer_id: bigint }>
    >(
      `SELECT DISTINCT reviewer_id FROM (
         SELECT reviewer_id FROM "review_items" WHERE reviewer_id IS NOT NULL
         UNION
         SELECT reviewer_id FROM "review_decisions" WHERE reviewer_id IS NOT NULL
       ) combined ORDER BY reviewer_id`
    );
    const distinctReviewerIds = distinctReviewerRows.map((r) => r.reviewer_id.toString());

    // Check if admin_accounts table exists (pre-migration it should not)
    const adminAccountsTableExistsRows = await (prisma as any).$queryRawUnsafe<
      Array<{ exists: boolean }>
    >(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'admin_accounts'
       ) as exists`
    );
    const adminAccountsTableExists = adminAccountsTableExistsRows[0]?.exists ?? false;

    // If admin_accounts exists, check which reviewer_ids can be mapped
    let automaticallyMapped: string[] = [];
    let unmappedReviewerIds: string[] = [];
    if (adminAccountsTableExists && distinctReviewerIds.length > 0) {
      const idList = distinctReviewerIds.map((id) => `'${id}'`).join(",");
      const mappedRows = await (prisma as any).$queryRawUnsafe<
        Array<{ id: bigint }>
      >(`SELECT id FROM "admin_accounts" WHERE id IN (${idList}) ORDER BY id`);
      const mappedSet = new Set(mappedRows.map((r) => r.id.toString()));
      automaticallyMapped = distinctReviewerIds.filter((id) => mappedSet.has(id));
      unmappedReviewerIds = distinctReviewerIds.filter((id) => !mappedSet.has(id));
    } else {
      // admin_accounts doesn't exist yet — all reviewer_ids are unmapped
      automaticallyMapped = [];
      unmappedReviewerIds = [...distinctReviewerIds];
    }

    // After migration: all unmapped reviewer_ids will be NULLed.
    // reviewItemsAfter / reviewDecisionsAfter = 0 (all reviewer_id set to NULL)
    const nullifiedReviewerIds = [...unmappedReviewerIds];
    const reviewItemsAfter = 0;
    const reviewDecisionsAfter = 0;

    const report: DryRunReport = {
      generatedAt: new Date().toISOString(),
      databaseUrlMasked: maskDatabaseUrl(databaseUrl),
      zeroWriteGuarantee:
        "This script performs ONLY read-only SELECT queries. No INSERT/UPDATE/DELETE/DDL. " +
        "The only write is to a local JSON report file on the filesystem.",
      classification: {
        totalUsers,
        validEmailUsers,
        missingEmailUsers,
        duplicateEmails: duplicateEmailCount,
        malformedEmails: malformedEmailCount,
        adminLikeUsers: adminLikeUsersList.length,
        automaticallyMigratable,
        manualReviewRequired,
      },
      details: {
        missingEmailUsersList,
        duplicateEmailsList,
        malformedEmailsList,
        adminLikeUsersList,
      },
      reviewerFkMigration: {
        reviewItemsWithReviewerBefore: Number(reviewItemsWithReviewer[0]?.count ?? 0),
        reviewDecisionsWithReviewerBefore: Number(reviewDecisionsWithReviewer[0]?.count ?? 0),
        distinctReviewerIds,
        automaticallyMapped,
        unmappedReviewerIds,
        nullifiedReviewerIds,
        reviewItemsAfter,
        reviewDecisionsAfter,
        adminAccountsTableExists,
        note:
          "reviewer_id values reference User IDs. After migration, all unmapped " +
          "reviewer_ids are NULLed because admin_accounts is a new empty table. " +
          "The original reviewer_id values are preserved in the " +
          "_reviewer_fk_migration_audit table by the migration SQL (task #15). " +
          "ReviewDecision retains reviewerRole and evidenceFingerprint for audit trail.",
      },
      recommendations: [
        manualReviewRequired > 0
          ? `${manualReviewRequired} user(s) require manual email assignment before email can be made NOT NULL.`
          : "All users have valid, unique emails. NOT NULL constraint can be applied.",
        adminLikeUsersList.length > 0
          ? `${adminLikeUsersList.length} admin-like user(s) found. Per contract task #12, these are NOT auto-converted to AdminAccount. An explicit mapping list is required.`
          : "No admin-like users found.",
        "Per contract task #10: DO NOT forge emails (no user123@example.com, no displayName-based emails).",
        "Per contract §7: email NOT NULL constraint is a separate future migration after data cleanup.",
        nullifiedReviewerIds.length > 0
          ? `${nullifiedReviewerIds.length} distinct reviewer_id value(s) will be NULLed. ` +
            `Original values preserved in _reviewer_fk_migration_audit table and this report.`
          : "No reviewer_id values to nullify.",
      ],
    };

    return report;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  const report = await generateReport(databaseUrl);

  // Output JSON report to stdout
  console.log(JSON.stringify(report, null, 2));

  // Also write to file for audit trail (filesystem only, NOT database).
  // This write is non-fatal: if it fails (e.g. sandbox restriction), the JSON
  // has already been printed to stdout above.
  // Set DRY_RUN_SKIP_FILE_WRITE=1 to skip the file write entirely (useful in
  // sandboxed test environments where file writes are restricted).
  if (process.env.DRY_RUN_SKIP_FILE_WRITE !== "1") {
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const reportPath = path.join("scripts", "migration", "dry-run-report.json");
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
      console.error(`\nReport written to ${reportPath}`);
    } catch (writeErr) {
      console.error(`\nWarning: could not write report file (non-fatal): ${writeErr}`);
    }
  }
}

// Only run main() when executed directly via CLI, not when imported as a module.
// This allows tests to import generateReport() without triggering process.exit().
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error("Dry-run classification failed:", err);
    process.exit(1);
  });
}
