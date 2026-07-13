// Phase 1+2 crawler-state: CrawlerJob PostgreSQL state machine + exact canary claim.
//
// Contract reference: docs/implementation/PHASE12_CONTRACT.md §5 (CrawlerJobStatus)
//   - PostgreSQL is the source of truth for CrawlerJob rows
//   - Redis is ONLY a cache mirror + ZSET queue index (rebuildable from PG)
//   - State transitions are enforced server-side; illegal transitions throw
//   - Canary mode requires exact --job-id allowlist; queue-wide claim is forbidden
//   - resultSummary and writeback evidence MUST persist to PG
//
// This module provides:
//   1. CRAWLER_JOB_STATUSES + LEGACY_CRAWLER_STATUS_MAP — canonical enums
//   2. CRAWLER_JOB_TRANSITIONS — legal state transition map
//   3. assertLegalTransition(from, to) — transition validator
//   4. CrawlerJobRepository — PG-backed CRUD with state machine enforcement
//
// Run tests: npx tsx --test src/crawler/stateMachine.test.ts

import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";

// ─── Canonical status enum ───────────────────────────────────────────────────

export const CRAWLER_JOB_STATUSES = [
  "created",
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "deferred",
] as const;
export type CrawlerJobStatus = (typeof CRAWLER_JOB_STATUSES)[number];

// ─── Legacy status reconciliation ────────────────────────────────────────────
// Maps legacy Redis-only statuses to the canonical enum.
// Per contract §5: succeeded → completed, cancelled → failed.
export const LEGACY_CRAWLER_STATUS_MAP: Record<string, CrawlerJobStatus> = {
  queued: "queued",
  claimed: "claimed",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  deferred: "deferred",
  cancelled: "failed",
  // "created" is new — legacy jobs never had it, but include for completeness
  created: "created",
};

// ─── Legal state transitions ─────────────────────────────────────────────────
// Contract §5:
//   created ──release/enqueue──▶ queued
//   queued ──claim──────────────▶ claimed
//   claimed ──start──────────────▶ running
//   running ──success────────────▶ completed
//   running ──error──────────────▶ failed
//   running ──429/403/captcha────▶ deferred
//   claimed ──timeout/release────▶ queued   (re-queue, attempt counter unchanged)
//   deferred ──notBefore passed──▶ queued    (re-queue, attempt counter unchanged)
//   failed ──admin retry─────────▶ created   (new attempt, attempt counter +1)
//   completed ──(terminal)──────▶ —
export const CRAWLER_JOB_TRANSITIONS: Record<CrawlerJobStatus, CrawlerJobStatus[]> = {
  created: ["queued"],
  queued: ["claimed"],
  claimed: ["running", "queued"],
  running: ["completed", "failed", "deferred"],
  completed: [], // terminal
  failed: ["created"], // admin retry only
  deferred: ["queued"],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly jobId?: string,
  ) {
    super(
      `Illegal CrawlerJob transition: ${from} → ${to}` +
        (jobId ? ` (job ${jobId})` : "") +
        `. Legal targets from ${from}: ${(CRAWLER_JOB_TRANSITIONS[from as CrawlerJobStatus] || []).join(", ") || "(terminal)"}`,
    );
    this.name = "IllegalTransitionError";
  }
}

export function reconcileLegacyStatus(legacy: string): CrawlerJobStatus {
  const mapped = LEGACY_CRAWLER_STATUS_MAP[legacy];
  if (!mapped) {
    // Unknown legacy status — fail-closed to "created" so the job gets re-queued
    // rather than silently dropped. This is safe because "created" is the
    // initial state and the job will transition through the normal flow.
    return "created";
  }
  return mapped;
}

export function assertLegalTransition(
  from: CrawlerJobStatus | string,
  to: CrawlerJobStatus | string,
  jobId?: string,
): void {
  const fromCanonical = LEGACY_CRAWLER_STATUS_MAP[from] ?? (from as CrawlerJobStatus);
  const toCanonical = LEGACY_CRAWLER_STATUS_MAP[to] ?? (to as CrawlerJobStatus);
  const legal = CRAWLER_JOB_TRANSITIONS[fromCanonical];
  if (!legal || !legal.includes(toCanonical)) {
    throw new IllegalTransitionError(from, to, jobId);
  }
}

export function isTerminalStatus(status: CrawlerJobStatus | string): boolean {
  const canonical = LEGACY_CRAWLER_STATUS_MAP[status] ?? (status as CrawlerJobStatus);
  return CRAWLER_JOB_TRANSITIONS[canonical]?.length === 0;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export interface CreateCrawlerJobInput {
  id: string;
  source: string;
  task: string;
  runner?: string;
  priority?: number;
  payload?: any;
  maxAttempts?: number;
  notBefore?: Date;
  linkedReviewItemId?: string;
  notes?: string;
  automation?: any;
}

export interface ClaimResult {
  job: any;
  writeback: () => Promise<void>;
}

export interface ClaimOpts {
  runner: string;
  workerId: string;
  /**
   * Canary mode (contract §5): if canaryMode=true, jobIds MUST be a non-empty
   * array. The server claims ONLY those ids. Queue-wide claim (empty jobIds)
   * is forbidden in canary mode.
   */
  canaryMode?: boolean;
  jobIds?: string[];
  limit?: number;
}

export class CrawlerJobRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
  ) {}

  /**
   * Create a new CrawlerJob in PostgreSQL with status "created".
   * Per contract §5: "Manual/admin-created canary jobs start as `created`
   * and transition to `queued` only when explicitly released."
   */
  async create(input: CreateCrawlerJobInput): Promise<any> {
    const job = await this.prisma.crawlerJob.create({
      data: {
        id: input.id,
        source: input.source,
        task: input.task,
        runner: input.runner ?? "server_safe",
        status: "created",
        priority: input.priority ?? 1,
        payload: input.payload ?? undefined,
        maxAttempts: input.maxAttempts ?? 3,
        notBefore: input.notBefore ?? null,
        linkedReviewItemId: input.linkedReviewItemId ?? null,
        notes: input.notes ?? null,
        automation: input.automation ?? undefined,
      },
    });
    // Redis mirror is NOT populated yet — job is not visible to runners until
    // releaseToQueued() is called. This enforces the created → queued gate.
    return job;
  }

  /**
   * Release a "created" job to the queue: created → queued.
   * Populates the Redis ZSET index so runners can see it.
   */
  async releaseToQueued(id: string): Promise<any> {
    const existing = await this.prisma.crawlerJob.findUnique({ where: { id } });
    if (!existing) throw new Error(`CrawlerJob not found: ${id}`);
    assertLegalTransition(existing.status, "queued", id);

    const updated = await this.prisma.crawlerJob.update({
      where: { id },
      data: { status: "queued", updatedAt: new Date() },
    });
    // Add to Redis ZSET with priority-based score (lower priority value = higher queue priority)
    const score = Date.now() + (existing.priority ?? 1) * 1_000_000_000;
    await this.redis.zadd("crawler:jobs", score, id);
    await this.redis.set(`crawler:job:${id}`, JSON.stringify(updated));
    return updated;
  }

  /**
   * Exact canary claim (contract §5 + §12).
   *
   * In canary mode, the request MUST include jobIds: [id1, id2]. The server
   * claims ONLY those ids. Queue-wide consumption (no jobIds) is forbidden.
   *
   * Claims transition queued → claimed, increment attempts, and set workerId.
   * Returns claimed jobs plus a writeback closure for the runner to call
   * when it finishes (to persist result to PG).
   */
  async claimJobs(opts: ClaimOpts): Promise<ClaimResult[]> {
    if (opts.canaryMode) {
      if (!opts.jobIds || opts.jobIds.length === 0) {
        throw new Error(
          "Canary mode requires explicit jobIds (queue-wide claim is forbidden). " +
            "Pass canaryMode=false for queue-wide consumption.",
        );
      }
    }
    const limit = opts.limit ?? 1;
    const now = new Date();
    const nowMs = now.getTime();

    // Determine candidate IDs
    let candidateIds: string[];
    if (opts.jobIds && opts.jobIds.length > 0) {
      candidateIds = opts.jobIds;
    } else {
      // Queue-wide: pull from Redis ZSET (legacy compat)
      const limitFloor = Math.max(limit * 5, limit);
      candidateIds = await this.redis.zrevrange("crawler:jobs", 0, limitFloor - 1);
    }

    const results: ClaimResult[] = [];
    for (const id of candidateIds) {
      if (results.length >= limit) break;
      const job = await this.prisma.crawlerJob.findUnique({ where: { id } });
      if (!job) continue;
      // Only queued or deferred (with notBefore passed) jobs are claimable
      if (job.status !== "queued" && job.status !== "deferred") continue;
      if (job.runner !== opts.runner) continue;
      if (job.notBefore && job.notBefore.getTime() > nowMs) continue;
      if (job.attempts >= job.maxAttempts) continue;

      assertLegalTransition(job.status, "claimed", id);

      const updated = await this.prisma.crawlerJob.update({
        where: { id },
        data: {
          status: "claimed",
          attempts: job.attempts + 1,
          workerId: opts.workerId,
          claimedAt: now,
          updatedAt: now,
        },
      });
      await this.redis.set(`crawler:job:${id}`, JSON.stringify(updated));

      // Return a writeback closure the runner calls when done
      const repo = this;
      const writeback = async () => {
        const refreshed = await repo.prisma.crawlerJob.findUnique({ where: { id } });
        if (refreshed) {
          await repo.redis.set(`crawler:job:${id}`, JSON.stringify(refreshed));
        }
      };
      results.push({ job: updated, writeback });
    }

    return results;
  }

  /**
   * Start a claimed job: claimed → running.
   */
  async start(id: string): Promise<any> {
    const existing = await this.prisma.crawlerJob.findUnique({ where: { id } });
    if (!existing) throw new Error(`CrawlerJob not found: ${id}`);
    assertLegalTransition(existing.status, "running", id);
    const updated = await this.prisma.crawlerJob.update({
      where: { id },
      data: { status: "running", runningAt: new Date(), updatedAt: new Date() },
    });
    await this.redis.set(`crawler:job:${id}`, JSON.stringify(updated));
    return updated;
  }

  /**
   * Complete a running job: running → completed.
   * Persists resultSummary to PG (contract §5: "resultSummary and writeback
   * evidence MUST be persisted to PostgreSQL, not only Redis").
   */
  async complete(id: string, resultSummary: any, result?: any): Promise<any> {
    const existing = await this.prisma.crawlerJob.findUnique({ where: { id } });
    if (!existing) throw new Error(`CrawlerJob not found: ${id}`);
    assertLegalTransition(existing.status, "completed", id);
    const updated = await this.prisma.crawlerJob.update({
      where: { id },
      data: {
        status: "completed",
        resultSummary: resultSummary ?? undefined,
        result: result ?? undefined,
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await this.redis.set(`crawler:job:${id}`, JSON.stringify(updated));
    // Remove from active queue ZSET (job is terminal)
    await this.redis.zrem("crawler:jobs", id);
    return updated;
  }

  /**
   * Fail a running job: running → failed.
   * If attempts < maxAttempts, the caller may later admin-retry (failed → created).
   * If attempts >= maxAttempts, the job is terminal.
   */
  async fail(id: string, error: string): Promise<any> {
    const existing = await this.prisma.crawlerJob.findUnique({ where: { id } });
    if (!existing) throw new Error(`CrawlerJob not found: ${id}`);
    assertLegalTransition(existing.status, "failed", id);
    const updated = await this.prisma.crawlerJob.update({
      where: { id },
      data: {
        status: "failed",
        error: error.slice(0, 2000),
        updatedAt: new Date(),
      },
    });
    await this.redis.set(`crawler:job:${id}`, JSON.stringify(updated));
    // Remove from active queue ZSET (job is terminal or awaiting admin retry)
    await this.redis.zrem("crawler:jobs", id);
    return updated;
  }

  /**
   * Defer a running job: running → deferred.
   * Used when the runner hits 429/403/captcha and needs to back off.
   * The job will be re-queued automatically when notBefore passes (via
   * a periodic sweeper or the next claim attempt).
   */
  async defer(id: string, notBefore: Date, reason?: string): Promise<any> {
    const existing = await this.prisma.crawlerJob.findUnique({ where: { id } });
    if (!existing) throw new Error(`CrawlerJob not found: ${id}`);
    assertLegalTransition(existing.status, "deferred", id);
    const updated = await this.prisma.crawlerJob.update({
      where: { id },
      data: {
        status: "deferred",
        notBefore,
        notes: reason ? `Deferred: ${reason}` : undefined,
        updatedAt: new Date(),
      },
    });
    await this.redis.set(`crawler:job:${id}`, JSON.stringify(updated));
    // Update ZSET score so the job is visible again only after notBefore
    await this.redis.zadd("crawler:jobs", notBefore.getTime(), id);
    return updated;
  }

  /**
   * Release a claimed job back to the queue: claimed → queued.
   * Used on timeout or when the runner gives up without starting.
   * Attempt counter is NOT incremented (per contract §5).
   */
  async releaseClaim(id: string): Promise<any> {
    const existing = await this.prisma.crawlerJob.findUnique({ where: { id } });
    if (!existing) throw new Error(`CrawlerJob not found: ${id}`);
    assertLegalTransition(existing.status, "queued", id);
    const updated = await this.prisma.crawlerJob.update({
      where: { id },
      data: {
        status: "queued",
        workerId: null,
        claimedAt: null,
        updatedAt: new Date(),
      },
    });
    await this.redis.set(`crawler:job:${id}`, JSON.stringify(updated));
    return updated;
  }

  /**
   * Admin retry: failed → created.
   * Increments attempt counter (per contract §5: "new attempt, attempt counter +1").
   * Throws if maxAttempts is already exhausted.
   */
  async adminRetry(id: string): Promise<any> {
    const existing = await this.prisma.crawlerJob.findUnique({ where: { id } });
    if (!existing) throw new Error(`CrawlerJob not found: ${id}`);
    assertLegalTransition(existing.status, "created", id);
    if (existing.attempts >= existing.maxAttempts) {
      throw new Error(
        `CrawlerJob ${id} has exhausted maxAttempts (${existing.maxAttempts}). ` +
          `Increase maxAttempts or create a new job.`,
      );
    }
    const updated = await this.prisma.crawlerJob.update({
      where: { id },
      data: {
        status: "created",
        attempts: existing.attempts + 1,
        workerId: null,
        claimedAt: null,
        runningAt: null,
        completedAt: null,
        error: null,
        updatedAt: new Date(),
      },
    });
    await this.redis.set(`crawler:job:${id}`, JSON.stringify(updated));
    // NOT added to ZSET — must be explicitly released via releaseToQueued()
    return updated;
  }

  /**
   * Fetch a job by ID from PostgreSQL (source of truth).
   */
  async get(id: string): Promise<any | null> {
    return this.prisma.crawlerJob.findUnique({ where: { id } });
  }

  /**
   * List jobs from PostgreSQL with optional filters.
   */
  async list(opts: {
    status?: CrawlerJobStatus;
    runner?: string;
    source?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ jobs: any[]; total: number }> {
    const where: any = {};
    if (opts.status) where.status = opts.status;
    if (opts.runner) where.runner = opts.runner;
    if (opts.source) where.source = opts.source;
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const [jobs, total] = await Promise.all([
      this.prisma.crawlerJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.crawlerJob.count({ where }),
    ]);
    return { jobs, total };
  }

  /**
   * Rebuild the Redis ZSET index from PostgreSQL.
   * Used after migrations or when Redis is flushed (though FLUSHDB is forbidden).
   * Only non-terminal jobs (queued, claimed, running, deferred) are indexed.
   */
  async rebuildRedisIndex(batchSize = 100): Promise<{ indexed: number }> {
    // Clear existing ZSET
    await this.redis.del("crawler:jobs");
    let indexed = 0;
    let cursor: string | undefined = undefined;
    const activeStatuses = ["queued", "claimed", "running", "deferred"];
    do {
      const findArgs: {
        where: { status: { in: string[] } };
        orderBy: { createdAt: "asc" };
        take: number;
        skip?: number;
        cursor?: { id: string };
      } = {
        where: { status: { in: activeStatuses } },
        orderBy: { createdAt: "asc" },
        take: batchSize,
      };
      if (cursor) {
        findArgs.skip = 1;
        findArgs.cursor = { id: cursor };
      }
      const rows: any[] = await this.prisma.crawlerJob.findMany(findArgs);
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        const score = (row.notBefore?.getTime() ?? Date.now()) + (row.priority ?? 1) * 1_000_000_000;
        await this.redis.zadd("crawler:jobs", score, row.id);
        await this.redis.set(`crawler:job:${row.id}`, JSON.stringify(row));
        indexed++;
      }
      if (rows.length < batchSize) break;
    } while (true);
    return { indexed };
  }
}
