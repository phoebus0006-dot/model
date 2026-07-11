import { FastifyInstance } from "fastify";
import { crawlerJobSchema, crawlerJobUpdateSchema, crawlerJobQuerySchema, crawlerClaimSchema } from "./schemas.js";
import { CREATE_JOB_LUA, CLAIM_JOB_LUA } from "./lua-scripts.js";

export async function adminCrawlerRoutes(app: FastifyInstance) {
  app.get("/crawler/jobs", async (req: any) => {
    const query = crawlerJobQuerySchema.parse(req.query || {});
    const ids = await app.redis.zrevrange("crawler:jobs", 0, Math.max(query.limit * 5, query.limit) - 1);
    const jobs: any[] = [];
    for (const id of ids) {
      const raw = await app.redis.get(`crawler:job:${id}`);
      if (!raw) continue;
      try {
        const job = JSON.parse(raw);
        if (query.status && job.status !== query.status) continue;
        if (query.runner && job.runner !== query.runner) continue;
        if (query.source && job.source !== query.source) continue;
        jobs.push(job);
        if (jobs.length >= query.limit) break;
      } catch {}
    }
    return { success: true, data: jobs, meta: { count: jobs.length, limit: query.limit } };
  });

  app.post("/crawler/jobs", async (req: any, reply: any) => {
    const data = crawlerJobSchema.parse(req.body);
    const now = new Date().toISOString();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = { id, attempts: 0, ...data, createdAt: now, updatedAt: now };
    const score = Date.now() + data.priority * 1_000_000_000;
    const jobKey = `crawler:job:${id}`;
    const indexKey = "crawler:jobs";
    try {
      await app.redis.eval(CREATE_JOB_LUA, 2, jobKey, indexKey, JSON.stringify(job), String(score), id);
    } catch {
      // Fallback: Redis transaction if Lua not available
      const multi = app.redis.multi();
      multi.set(jobKey, JSON.stringify(job));
      multi.zadd(indexKey, score, id);
      await multi.exec();
    }
    return reply.status(201).send({ success: true, data: job });
  });

  app.post("/crawler/jobs/claim", async (req: any) => {
    const data = crawlerClaimSchema.parse(req.body);
    const nowMs = Date.now();
    const isoNow = new Date().toISOString();
    let claimedJobs: any[] = [];
    try {
      const rawResults = await app.redis.eval(
        CLAIM_JOB_LUA,
        1,
        "crawler:jobs",
        String(data.limit),
        data.runner,
        data.workerId,
        String(nowMs),
        isoNow
      );
      claimedJobs = Array.isArray(rawResults)
        ? rawResults.map((r: string) => JSON.parse(r))
        : [];
    } catch {
      // Fallback: original non-atomic claim logic
      const ids = await app.redis.zrevrange("crawler:jobs", 0, 500);
      for (const id of ids) {
        if (claimedJobs.length >= data.limit) break;
        const raw = await app.redis.get(`crawler:job:${id}`);
        if (!raw) continue;
        let job: any;
        try { job = JSON.parse(raw); } catch { continue; }
        if (job.status !== "queued" && job.status !== "deferred") continue;
        if (job.runner !== data.runner) continue;
        if (job.notBefore && Date.parse(job.notBefore) > nowMs) continue;
        if ((job.attempts || 0) >= (job.maxAttempts || 3)) continue;
        const updated = { ...job, status: "claimed", attempts: (job.attempts || 0) + 1, workerId: data.workerId, claimedAt: isoNow, updatedAt: isoNow };
        await app.redis.set(`crawler:job:${id}`, JSON.stringify(updated));
        claimedJobs.push(updated);
      }
    }
    return { success: true, data: claimedJobs, meta: { count: claimedJobs.length } };
  });

  app.get("/crawler/jobs/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const raw = await app.redis.get(`crawler:job:${id}`);
    if (!raw) return reply.status(404).send({ success: false, error: { code: "CRAWLER_JOB_NOT_FOUND", message: "Crawler job not found" } });
    try { return { success: true, data: JSON.parse(raw) }; }
    catch { return reply.status(500).send({ success: false, error: { code: "CRAWLER_JOB_PARSE_ERROR", message: "Failed to parse job JSON" } }); }
  });

  app.put("/crawler/jobs/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const existingRaw = await app.redis.get(`crawler:job:${id}`);
    if (!existingRaw) return reply.status(404).send({ success: false, error: { code: "CRAWLER_JOB_NOT_FOUND" } });
    const update = crawlerJobUpdateSchema.parse(req.body);
    const existing = JSON.parse(existingRaw);
    const job = { ...existing, ...update, updatedAt: new Date().toISOString() };
    await app.redis.set(`crawler:job:${id}`, JSON.stringify(job));
    return { success: true, data: job };
  });
}
