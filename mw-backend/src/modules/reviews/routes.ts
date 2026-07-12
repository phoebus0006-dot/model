import { FastifyInstance } from "fastify";
import crypto from "crypto";
import { ReviewRepository } from "./repository.js";
import { ReviewService, computeReviewEvidenceFingerprint, reviewDecisionKey, reviewDecisionMatchesQuery, projectReviewDecision, reviewFigureKey, reviewRiskKey } from "./service.js";
import { reviewItemSchema, reviewUpdateSchema, reviewQuerySchema, reviewDecisionQuerySchema, reviewActionSchema, bulkCleanupSchema, reviewStatusSchema, reviewEditableFieldsSchema } from "./schemas.js";
import { ACTION_STATUS_MAP, isSuppressingAction, type ReviewAction } from "./types.js";
import { scanKeys } from "../../shared/cache/scan-keys.js";

const ALL_STATUSES = "all";
const REVIEW_FORBIDDEN_UPDATE_FIELDS = new Set(["status", "decisionReason", "reviewer", "decisionAt", "action", "createdAt"]);

async function resolveReviewFigure(prisma: any, item: any, payload: any) {
  const slug = item.figureSlug || payload.figureSlug || payload.slug || payload.figure?.slug;
  const id = item.figureId || payload.figureId || payload.figure?.id;
  if (id !== undefined && id !== null && /^\d+$/.test(String(id))) {
    const byId = await prisma.figure.findFirst({ where: { id: BigInt(id), isDeleted: false }, select: { id: true, slug: true, name: true, janCode: true, activeRevisionId: true } });
    if (byId) return byId;
  }
  if (slug) return prisma.figure.findFirst({ where: { slug: String(slug), isDeleted: false }, select: { id: true, slug: true, name: true, janCode: true, activeRevisionId: true } });
  return null;
}

async function normalizeReviewItemForFingerprint(app: FastifyInstance, item: any) {
  const payload = item.payload || {};
  const resolved = await resolveReviewFigure(app.prisma, item, payload);
  if (!resolved) return { ...item, evidenceFingerprint: item.evidenceFingerprint || computeReviewEvidenceFingerprint(item) };
  const figure = await app.prisma.figure.findUnique({
    where: { id: resolved.id },
    select: { id: true, slug: true, description: true, scale: true, material: true, priceJpy: true, releaseDate: true, heightMm: true, weightG: true, productLine: true, ageRating: true, manufacturer: { select: { id: true, name: true } }, series: { select: { id: true, name: true } }, categories: { select: { categoryId: true }, orderBy: { categoryId: "asc" } }, images: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, source: true, sha256: true, width: true, height: true, size: true, sortOrder: true, data: true } } },
  });
  if (!figure) return { ...item, figureId: String(resolved.id), figureSlug: resolved.slug, evidenceFingerprint: item.evidenceFingerprint || computeReviewEvidenceFingerprint({ ...item, figureId: String(resolved.id), figureSlug: resolved.slug }) };
  const imageRows = (figure.images || []).map((im: any) => ({ id: String(im.id), source: im.source || null, sha256: im.sha256 || null, width: im.width ?? null, height: im.height ?? null, size: im.size || null, sortOrder: im.sortOrder ?? null, sourceKind: (im.data && typeof im.data === "object") ? (im.data as any).source_kind || null : null, safeDisplay: (im.data && typeof im.data === "object") ? (im.data as any).safe_display === true : false, imageLowQuality: (im.data && typeof im.data === "object") ? (im.data as any).image_low_quality === true : false }));
  const primary = imageRows[0] || null;
  const currentStateEvidence = { figure: { id: String(figure.id), slug: figure.slug }, images: { primaryImageId: primary?.id || null, imageIds: imageRows.map((i: any) => i.id).sort(), rows: imageRows }, detail: { description: figure.description || null, scale: figure.scale || null, material: figure.material || null, priceJpy: figure.priceJpy ?? null, releaseDate: figure.releaseDate ? figure.releaseDate.toISOString() : null, heightMm: figure.heightMm ?? null, weightG: figure.weightG ?? null, productLine: figure.productLine || null, ageRating: figure.ageRating || null, manufacturer: figure.manufacturer ? { id: String(figure.manufacturer.id), name: figure.manufacturer.name } : null, series: figure.series ? { id: String(figure.series.id), name: figure.series.name } : null, categories: (figure.categories || []).map((row: any) => String(row.categoryId)), specCount: [figure.scale, figure.material, figure.priceJpy, figure.releaseDate, figure.heightMm, figure.weightG, figure.productLine, figure.ageRating, figure.manufacturer?.name, figure.series?.name].filter((f: any) => f != null && String(f) !== "").length } };
  const normalized = { ...item, figureId: String(figure.id), figureSlug: figure.slug, currentStateEvidence, payload: { ...payload, submittedEvidenceFingerprint: item.evidenceFingerprint || payload.submittedEvidenceFingerprint || null, currentStateEvidence } };
  return { ...normalized, evidenceFingerprint: computeReviewEvidenceFingerprint(normalized) };
}

import { adminApplyRoute } from "./apply-route.js";

export async function adminReviewRoutes(app: FastifyInstance) {
  // Apply route with embedded lock lease lifecycle
  await app.register(adminApplyRoute);
  app.get("/review/items", async (req: any) => {
    const query = reviewQuerySchema.parse(req.query || {});
    const statusFilter = query.status || "pending";
    const showAll = statusFilter === ALL_STATUSES;
    const ids = await app.redis.zrevrange("review:items", 0, -1);
    const filtered: any[] = [];
    for (const id of ids) {
      const raw = await app.redis.get("review:item:" + id);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        if (!showAll && item.status !== statusFilter) continue;
        if (query.type && item.type !== query.type) continue;
        if (query.riskType && item.riskType !== query.riskType) continue;
        if (query.suggestedAction && item.suggestedAction !== query.suggestedAction) continue;
        filtered.push(item);
      } catch {}
    }
    const total = filtered.length;
    const offset = query.offset || 0;
    const items = filtered.slice(offset, offset + query.limit);
    return { success: true, data: items, meta: { count: items.length, total, limit: query.limit, offset, defaultStatus: statusFilter } };
  });

  app.get("/review/decisions", async (req: any) => {
    const query = reviewDecisionQuerySchema.parse(req.query || {});
    let mappedFigureId: string | undefined;
    if (query.figureSlug) {
      const figure = await app.prisma.figure.findFirst({ where: { slug: query.figureSlug, isDeleted: false }, select: { id: true } });
      if (figure) mappedFigureId = String(figure.id);
    }
    const keys = await app.redis.zrevrange("review:decisions", 0, -1);
    const filtered: any[] = [];
    for (const key of keys) {
      if (!String(key).startsWith("review:decision:")) continue;
      const raw = await app.redis.get(key);
      if (!raw) continue;
      try {
        const decision = JSON.parse(raw);
        if (!reviewDecisionMatchesQuery(decision, query as any, mappedFigureId)) continue;
        filtered.push(projectReviewDecision(decision));
      } catch {}
    }
    const total = filtered.length;
    const offset = query.offset || 0;
    const data = filtered.slice(offset, offset + query.limit);
    return { success: true, data, meta: { count: data.length, total, limit: query.limit, offset } };
  });

  app.get("/review/stats", async () => {
    const ids = await app.redis.zrevrange("review:items", 0, -1);
    const stats = { total: 0, pending: 0, pending_image_review: 0, pending_detail_review: 0, pending_rewrite: 0, pending_figure_import: 0, stale: 0, resolved: 0, rejected: 0, approved: 0, needs_changes: 0, archived: 0 };
    for (const id of ids) {
      const raw = await app.redis.get("review:item:" + id);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        stats.total++;
        const s = item.status || "unknown";
        if (s === "pending") {
          stats.pending++;
          const t = item.type || "";
          if (t === "image_review") stats.pending_image_review++;
          else if (t === "detail_review") stats.pending_detail_review++;
          else if (t === "rewrite") stats.pending_rewrite++;
          else if (t === "figure_import") stats.pending_figure_import++;
        } else if (s === "stale") stats.stale++;
        else if (s === "resolved") stats.resolved++;
        else if (s === "rejected") stats.rejected++;
        else if (s === "approved") stats.approved++;
        else if (s === "needs_changes") stats.needs_changes++;
      } catch {}
    }
    stats.archived = await app.redis.zcard("review:archive");
    return { success: true, data: stats };
  });

  app.post("/review/items", async (req: any, reply: any) => {
    const data = reviewItemSchema.parse(req.body);
    const now = new Date().toISOString();
    const candidateItem = await normalizeReviewItemForFingerprint(app, data);
    const dk = reviewDecisionKey(candidateItem);
    if (dk) {
      const decisionRaw = await app.redis.get(dk);
      if (decisionRaw) {
        try {
          const decision = JSON.parse(decisionRaw);
          return reply.status(200).send({ success: true, data: { ...candidateItem, id: null, status: "suppressed", suppressed: true, suppressionReason: "human_decision_exists", decision }, meta: { suppressed: true, reason: "human_decision_exists", decision } });
        } catch {}
      }
    }
    const ids = await app.redis.zrevrange("review:items", 0, -1);
    let existingPending: any = null;
    for (const pid of ids) {
      const raw = await app.redis.get("review:item:" + pid);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        if (item.status !== "pending") continue;
        const ni = await normalizeReviewItemForFingerprint(app, item);
        const fp = ni.evidenceFingerprint || computeReviewEvidenceFingerprint(ni);
        const rt = reviewRiskKey(ni);
        const fk = reviewFigureKey(ni);
        if (fp === dk && rt === reviewRiskKey(candidateItem) && fk === reviewFigureKey(candidateItem)) {
          existingPending = item; break;
        }
      } catch {}
    }
    if (existingPending) return reply.status(200).send({ success: true, data: existingPending, meta: { duplicate: true, reason: "pending_review_exists" } });
    const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const item = { id, ...candidateItem, createdAt: now, updatedAt: now };
    await app.redis.set("review:item:" + id, JSON.stringify(item));
    await app.redis.zadd("review:items", Date.now(), id);
    return reply.status(201).send({ success: true, data: item });
  });

  app.put("/review/items/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const existingRaw = await app.redis.get("review:item:" + id);
    if (!existingRaw) return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
    const body = req.body || {};
    const forbiddenKeys = Object.keys(body).filter((k) => REVIEW_FORBIDDEN_UPDATE_FIELDS.has(k));
    if (forbiddenKeys.length > 0) return reply.status(422).send({ success: false, error: { code: "FORBIDDEN_FIELDS", message: "Cannot modify review state via generic update: " + forbiddenKeys.join(", ") + ". Use /action endpoint.", fields: forbiddenKeys } });
    const update = reviewEditableFieldsSchema.strict().parse(body);
    const existing = JSON.parse(existingRaw);
    const item = { ...existing, ...update, updatedAt: new Date().toISOString() };
    const versionChanged = existing.version !== undefined && item.version !== existing.version;
    if (versionChanged) return reply.status(409).send({ success: false, error: { code: "VERSION_CONFLICT", message: "Item version has changed" } });
    await app.redis.set("review:item:" + id, JSON.stringify(item));
    return { success: true, data: item };
  });

  app.post("/review/items/:id/recheck", async (req: any, reply: any) => {
    return reply.status(410).send({ success: false, error: { code: "LEGACY_RECHECK_REMOVED", message: "This endpoint has been removed in favor of the new review lifecycle. Use POST /review/items/:id/action instead." } });
  });

  app.post("/review/items/:id/action", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const actionBody = reviewActionSchema.parse((req.body || {}).action);
    const existingRaw = await app.redis.get("review:item:" + id);
    if (!existingRaw) return reply.status(404).send({ success: false, error: { code: "REVIEW_ITEM_NOT_FOUND" } });
    const item = JSON.parse(existingRaw);
    const now = new Date().toISOString();
    const targetStatus = ACTION_STATUS_MAP[actionBody as ReviewAction];
    if (!targetStatus) {
      return reply.status(422).send({ success: false, error: { code: "UNSUPPORTED_ACTION", message: "Unsupported review action: " + actionBody } });
    }
    const newStatus = targetStatus;
    const reviewer = (req as any).user?.displayName || String((req as any).user?.userId || "");
    const note = (reviewer ? "[" + reviewer + "] " : "") + actionBody;
    const userNote = (req.body || {}).notes ? "（" + (req.body || {}).notes + "）" : "";
    const isFinal = isSuppressingAction(actionBody);
    const updatedItem = { ...item, status: newStatus, evidenceFingerprint: item.evidenceFingerprint || computeReviewEvidenceFingerprint(item), decisionReason: isFinal ? ((req.body || {}).notes || null) : item.decisionReason, reviewer: isFinal ? (reviewer || null) : item.reviewer, decisionAt: isFinal ? now : item.decisionAt, notes: item.notes ? item.notes + "\n[" + now + "] " + note + userNote : "[" + now + "] " + note + userNote, payload: { ...(item.payload || {}), lastAction: actionBody, lastActionAt: now, evidenceFingerprint: item.evidenceFingerprint || computeReviewEvidenceFingerprint(item) }, updatedAt: now };
    updatedItem.evidenceFingerprint = updatedItem.evidenceFingerprint || computeReviewEvidenceFingerprint(updatedItem);
    await app.redis.set("review:item:" + id, JSON.stringify(updatedItem));
    if (isFinal) {
      const dk = reviewDecisionKey(updatedItem);
      if (dk) {
        const decision = { reviewItemId: id, figure: reviewFigureKey(updatedItem), type: updatedItem.type || "general", riskType: reviewRiskKey(updatedItem), evidenceFingerprint: updatedItem.evidenceFingerprint || "", action: actionBody, status: newStatus, reviewer: reviewer || null, decisionReason: (req.body || {}).notes || null, decisionAt: now };
        await app.redis.set(dk, JSON.stringify(decision));
        await app.redis.zadd("review:decisions", Date.now(), dk);
      }
    }
    if (actionBody === "request_changes") {
      const fid = item.figureId ? String(item.figureId) : null;
      const jobId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const job = { id: jobId, attempts: 0, source: "manual", task: "fetch_item", runner: "local_browser", status: "queued", priority: 2, payload: { figureId: fid, figureSlug: item.figureSlug || "", reason: item.riskReason || "Refetch from review", reviewItemId: id, needImages: item.type !== "detail_review", needDetails: item.type === "detail_review" }, notes: "Created from review action", notBefore: new Date().toISOString(), maxAttempts: 3, automation: { provider: "manual", workflow: "review-refetch" }, createdAt: now, updatedAt: now };
      await app.redis.set("crawler:job:" + jobId, JSON.stringify(job));
      await app.redis.zadd("crawler:jobs", Date.now() + 2 * 1_000_000_000, jobId);
      updatedItem.payload = { ...(updatedItem.payload || {}), crawlerJobId: jobId };
      await app.redis.set("review:item:" + id, JSON.stringify(updatedItem));
    }
    return { success: true, data: { item: updatedItem, action: actionBody } };
  });

  app.post("/review/items/bulk/cleanup", async (req: any, reply: any) => {
    const body = bulkCleanupSchema.parse(req.body || {});
    const cutoff = Date.now() - body.olderThanDays * 86400000;
    const ids = await app.redis.zrevrange("review:items", 0, -1);
    const updated: string[] = [];
    const skipped: string[] = [];
    for (const bid of ids) {
      const raw = await app.redis.get("review:item:" + bid);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        if (item.type !== "rewrite" || item.source !== "localized-description-sync") { skipped.push(bid); continue; }
        if (item.status !== "resolved" && item.status !== "stale") { skipped.push(bid); continue; }
        const ts = Date.parse(item.updatedAt || item.createdAt || "");
        if (isNaN(ts) || ts > cutoff) { skipped.push(bid); continue; }
        if (body.dryRun) { updated.push(bid); continue; }
        if (body.markStale && item.status !== "stale") {
          const nnow = new Date().toISOString();
          item.status = "stale";
          item.notes = item.notes ? item.notes + "\n[" + nnow + "] 自动清理：已 resolved 的旧 rewrite 项标记为 stale" : "[" + nnow + "] 自动清理：已 resolved 的旧 rewrite 项标记为 stale";
          item.updatedAt = nnow;
          await app.redis.set("review:item:" + bid, JSON.stringify(item));
        }
        updated.push(bid);
      } catch {}
    }
    return { success: true, data: { updatedCount: updated.length, skippedCount: skipped.length, totalScanned: ids.length, dryRun: body.dryRun, sampleUpdated: updated.slice(0, 5) } };
  });
}
