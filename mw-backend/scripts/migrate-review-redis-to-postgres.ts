#!/usr/bin/env tsx
// Redis → PostgreSQL migration CLI for ReviewItem data.
//
// Agent A (review-storage) — Phase 1+2 carry-over.
//
// Contract reference: docs/implementation/PHASE12_CONTRACT.md §0, §13
//   - PostgreSQL is the source of truth; Redis is cache only.
//   - This script backfills ReviewItem rows from the legacy Redis store
//     into PostgreSQL. It NEVER deletes or modifies the original Redis data.
//   - Dry-run is the default; --execute is required to actually write to PG.
//
// Usage:
//   npx tsx scripts/migrate-review-redis-to-postgres.ts            # dry-run
//   npx tsx scripts/migrate-review-redis-to-postgres.ts --execute    # write
//   npx tsx scripts/migrate-review-redis-to-postgres.ts --verbose    # verbose dry-run
//
// Output: JSON stats object on stdout (single line), human-readable log on stderr.
//
// Stats:
//   beforeCount      — PG review_items count before migration
//   classifiedCount  — total Redis review items discovered
//   migratableCount  — items that passed validation and are not duplicates
//   duplicateCount   — items with same fingerprint already in PG (active)
//   invalidCount     — items missing required fields or unparseable
//   migratedCount    — items successfully written to PG (0 in dry-run)
//   skippedCount     — items skipped (already in PG by id, or no data)
//   failedCount      — items that failed to write (PG error)
//   afterCount       — PG review_items count after migration
//
// Rollback: this script does NOT delete Redis data. To roll back, simply
// truncate the review_items table in PG (the Redis data is still intact):
//   TRUNCATE review_items RESTART IDENTITY CASCADE;  -- run manually
// Then re-run the migration.

import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { runMigration } from "../src/domain/review/migration";

const isExecute = process.argv.includes("--execute");
const verbose = process.argv.includes("--verbose") || process.env.MIGRATE_VERBOSE === "1";

function log(msg: string): void {
  process.stderr.write(`[migrate] ${msg}\n`);
}

async function main(): Promise<void> {
  const mode = isExecute ? "EXECUTE (write)" : "DRY-RUN (no writes)";
  log(`Starting Redis → PostgreSQL migration [${mode}]`);

  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: 3,
  });

  try {
    const stats = await runMigration({ prisma, redis, isExecute, verbose });

    log(`PG review_items before: ${stats.beforeCount}`);
    log(`Redis review items discovered: ${stats.classifiedCount}`);
    log(`PG review_items after: ${stats.afterCount}`);
    log(
      `Done. migratable=${stats.migratableCount}, migrated=${stats.migratedCount}, ` +
        `duplicate=${stats.duplicateCount}, invalid=${stats.invalidCount}, ` +
        `skipped=${stats.skippedCount}, failed=${stats.failedCount}`,
    );

    if (!isExecute && stats.migratableCount > 0) {
      log("DRY-RUN: no data was written. Re-run with --execute to perform the migration.");
    }

    // Output stats as JSON on stdout (single line for easy parsing)
    process.stdout.write(JSON.stringify(stats) + "\n");
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main().catch((e) => {
  log(`Fatal error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
