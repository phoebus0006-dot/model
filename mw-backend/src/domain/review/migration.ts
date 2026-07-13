// Redis → PostgreSQL migration core logic for ReviewItem data.
//
// This module is importable from both the CLI script (scripts/) and from
// tests (src/domain/review/*.test.ts). The script at
// scripts/migrate-review-redis-to-postgres.ts is a thin CLI wrapper.
//
// Agent A (review-storage) — Phase 1+2 carry-over.
//
// Contract: docs/implementation/PHASE12_CONTRACT.md §0, §13
//   - PostgreSQL is the source of truth; Redis is cache only.
//   - This migration NEVER deletes or modifies the original Redis data.
//   - Dry-run is the default; --execute is required to actually write to PG.

const LEGACY_STATUS_MAP: Record<string, string> = {
  pending: "pending",
  needs_changes: "needs_changes",
  resolved: "resolved",
  rejected: "rejected",
  archived: "archived",
  approved: "resolved",
  stale: "archived",
};

function reconcileStatus(raw: string | undefined): string {
  const v = raw ?? "pending";
  return LEGACY_STATUS_MAP[v] ?? "pending";
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MigrationStats {
  beforeCount: number;
  classifiedCount: number;
  migratableCount: number;
  duplicateCount: number;
  invalidCount: number;
  migratedCount: number;
  skippedCount: number;
  failedCount: number;
  afterCount: number;
}

export interface MigrationDeps {
  prisma: any;
  redis: any;
  isExecute: boolean;
  verbose?: boolean;
}

// ─── Core migration function ─────────────────────────────────────────────────

/**
 * Migrate ReviewItem data from Redis to PostgreSQL.
 *
 * @param deps - Injected dependencies (prisma, redis, mode flags)
 * @returns Migration statistics
 *
 * Invariants:
 *   - Never deletes or modifies Redis data
 *   - Dry-run (isExecute=false) does NOT call prisma.reviewItem.create
 *   - Reconciles legacy status values (approved→resolved, stale→archived)
 *   - Skips items already in PG by id
 *   - Suppresses duplicates by fingerprint (active items only)
 */
export async function runMigration(deps: MigrationDeps): Promise<MigrationStats> {
  const { prisma, redis, isExecute: doExecute } = deps;
  const verbose = deps.verbose ?? false;

  const stats: MigrationStats = {
    beforeCount: 0,
    classifiedCount: 0,
    migratableCount: 0,
    duplicateCount: 0,
    invalidCount: 0,
    migratedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    afterCount: 0,
  };

  // Count existing PG items
  stats.beforeCount = await prisma.reviewItem.count();

  // ── Discover review item ids from Redis ──
  const reviewIds = new Set<string>();

  // 1. From ZSET indexes
  const zsetActive = await redis.zrange("review:items", 0, -1);
  zsetActive.forEach((id: string) => reviewIds.add(id));
  const zsetArchive = await redis.zrange("review:archive", 0, -1);
  zsetArchive.forEach((id: string) => reviewIds.add(id));

  // 2. From review:item:* keys via SCAN
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "review:item:*", "COUNT", 100);
    cursor = next;
    for (const key of keys) {
      const id = key.replace("review:item:", "");
      reviewIds.add(id);
    }
  } while (cursor !== "0");

  stats.classifiedCount = reviewIds.size;

  // ── Process each item ──
  for (const id of reviewIds) {
    const raw = await redis.get(`review:item:${id}`);
    if (!raw) {
      stats.skippedCount++;
      continue;
    }

    let item: Record<string, unknown>;
    try {
      item = JSON.parse(raw);
    } catch {
      stats.invalidCount++;
      continue;
    }

    // Validate required fields
    const type = item.type as string | undefined;
    const title = item.title as string | undefined;
    if (!type || !title) {
      stats.invalidCount++;
      continue;
    }

    // Check if already in PG by id
    const existingById = await prisma.reviewItem.findUnique({ where: { id } });
    if (existingById) {
      stats.skippedCount++;
      continue;
    }

    // Reconcile status
    const status = reconcileStatus(item.status as string | undefined);
    const fingerprint = item.evidenceFingerprint as string | undefined;

    // Check for duplicates by fingerprint (active items only)
    if (fingerprint) {
      const dup = await prisma.reviewItem.findFirst({
        where: {
          evidenceFingerprint: fingerprint,
          status: { not: "archived" },
        },
      });
      if (dup) {
        stats.duplicateCount++;
        stats.skippedCount++;
        continue;
      }
    }

    stats.migratableCount++;

    if (!doExecute) {
      // Dry-run: do NOT write to PG
      continue;
    }

    // ── Execute: write to PG ──
    try {
      await prisma.reviewItem.create({
        data: {
          id,
          type,
          riskType: (item.riskType as string) ?? null,
          status,
          title,
          source: (item.source as string) ?? null,
          sourceId: (item.sourceId as string) ?? null,
          figureId: item.figureId != null ? BigInt(String(item.figureId)) : null,
          figureSlug: (item.figureSlug as string) ?? null,
          priority: (item.priority as number) ?? 1,
          confidence: (item.confidence as number) ?? null,
          riskReason: (item.riskReason as string) ?? null,
          candidateImage: (item.candidateImage as any) ?? null,
          candidateAsset: (item.candidateAsset as any) ?? null,
          currentPublicImage: (item.currentPublicImage as any) ?? null,
          originalEvidence: (item.originalEvidence as any) ?? null,
          currentStateSnapshot: (item.currentStateSnapshot as any) ?? null,
          detailSnapshot: (item.detailSnapshot as any) ?? null,
          suggestedAction: (item.suggestedAction as string) ?? null,
          payload: (item.payload as any) ?? null,
          notes: (item.notes as string) ?? null,
          evidenceFingerprint: fingerprint ?? `legacy-${id}`,
          forceReopen: false,
          crawlerJobId: (item.crawlerJobId as string) ?? null,
          automation: (item.automation as any) ?? null,
          reviewerId: item.reviewerId != null ? BigInt(String(item.reviewerId)) : null,
          decisionReason: (item.decisionReason as string) ?? null,
          decisionAt: item.decisionAt ? new Date(item.decisionAt as string) : null,
          lastAction: (item.lastAction as string) ?? null,
          createdAt: item.createdAt ? new Date(item.createdAt as string) : new Date(),
          updatedAt: item.updatedAt ? new Date(item.updatedAt as string) : new Date(),
        },
      });
      stats.migratedCount++;
    } catch {
      stats.failedCount++;
    }
  }

  stats.afterCount = await prisma.reviewItem.count();

  return stats;
}
