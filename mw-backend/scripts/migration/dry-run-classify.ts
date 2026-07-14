/**
 * Dry-run classification script for User email migration.
 *
 * Per Wave 1 Agent Contract task #9, this script classifies all existing Users
 * into the following categories BEFORE the account schema migration is applied:
 *
 *   - totalUsers:             total User records
 *   - validEmailUsers:        users with a non-null, well-formed email
 *   - missingEmailUsers:      users with NULL email (need manual recovery)
 *   - duplicateEmails:        emails appearing more than once (blocks unique index)
 *   - malformedEmails:        emails that don't pass basic format validation
 *   - adminLikeUsers:         users whose role suggests admin privileges (role=admin)
 *   - automaticallyMigratable: users whose email can be normalized without conflict
 *   - manualReviewRequired:   users needing human intervention before NOT NULL constraint
 *
 * Per task #10: DO NOT forge emails. This script does NOT generate fake emails.
 * Per task #11: Users without restorable email are preserved; listed in pending report.
 * Per task #12: AdminAccount init does NOT auto-convert from User.
 *
 * Usage:
 *   npx tsx scripts/migration/dry-run-classify.ts
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string (disposable DB, NOT production)
 */

import { PrismaClient } from "@prisma/client";

interface DryRunReport {
  generatedAt: string;
  databaseUrlMasked: string;
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
  reviewerIdImpact: {
    reviewItemsWithReviewer: number;
    reviewDecisionsWithReviewer: number;
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

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  try {
    // Fetch all users — do NOT assume any have email
    const users = await (prisma as any).$queryRawUnsafe<
      Array<{ id: bigint; display_name: string; role: string; email: string | null }>
    >(`SELECT id, display_name, role, email FROM "users" ORDER BY id`);

    const totalUsers = users.length;
    const missingEmailUsersList: DryRunReport["details"]["missingEmailUsersList"] = [];
    const malformedEmailsList: DryRunReport["details"]["malformedEmailsList"] = [];
    const adminLikeUsersList: DryRunReport["details"]["adminLikeUsersList"] = [];
    const emailCounts = new Map<string, { count: number; raw: string }>();

    let validEmailUsers = 0;
    let automaticallyMigratable = 0;

    for (const user of users) {
      const id = user.id.toString();
      const displayName = user.display_name;
      const role = user.role;

      // Classify admin-like users (role contains "admin")
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

    // Duplicate emails (by normalized form)
    const duplicateEmailsList: DryRunReport["details"]["duplicateEmailsList"] = [];
    for (const [normalized, info] of emailCounts) {
      if (info.count > 1) {
        duplicateEmailsList.push({ email: normalized, count: info.count });
      }
    }

    // Automatically migratable = valid email + no duplicate
    const duplicateEmailCount = duplicateEmailsList.reduce((sum, d) => sum + d.count, 0);
    automaticallyMigratable = validEmailUsers - duplicateEmailCount;

    // Users requiring manual review
    const missingEmailUsers = missingEmailUsersList.length;
    const malformedEmailCount = malformedEmailsList.length;
    const manualReviewRequired =
      missingEmailUsers + malformedEmailCount + duplicateEmailCount;

    // Reviewer impact
    const reviewItemsWithReviewer = await (prisma as any).$queryRawUnsafe<
      Array<{ count: bigint }>
    >(`SELECT COUNT(*)::bigint as count FROM "review_items" WHERE "reviewer_id" IS NOT NULL`);

    const reviewDecisionsWithReviewer = await (prisma as any).$queryRawUnsafe<
      Array<{ count: bigint }>
    >(`SELECT COUNT(*)::bigint as count FROM "review_decisions" WHERE "reviewer_id" IS NOT NULL`);

    const report: DryRunReport = {
      generatedAt: new Date().toISOString(),
      databaseUrlMasked: maskDatabaseUrl(databaseUrl),
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
      reviewerIdImpact: {
        reviewItemsWithReviewer: Number(reviewItemsWithReviewer[0]?.count ?? 0),
        reviewDecisionsWithReviewer: Number(reviewDecisionsWithReviewer[0]?.count ?? 0),
        note:
          "reviewer_id values reference User IDs. After migration, they will be NULLed " +
          "because admin_accounts is a new empty table. ReviewDecision retains " +
          "reviewerRole and evidenceFingerprint for audit trail.",
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
      ],
    };

    // Output JSON report to stdout
    console.log(JSON.stringify(report, null, 2));

    // Also write to file for audit trail
    const fs = await import("node:fs/promises");
    const reportPath = "scripts/migration/dry-run-report.json";
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.error(`\nReport written to ${reportPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Dry-run classification failed:", err);
  process.exit(1);
});
