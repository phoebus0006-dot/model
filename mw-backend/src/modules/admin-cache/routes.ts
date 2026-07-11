import { FastifyInstance } from "fastify";
import { CacheService } from "../../shared/cache/cache-service.js";

const CACHE_ALLOWLIST = [
  "figures:detail:*",
  "figures:list:*",
  "search:*",
  "homepage:*",
  "series:list:*",
  "sculptors:list:*",
  "manufacturers:list:*",
  "characters:list:*",
  "categories:*",
  "legacy:import:result:*",
];

const BLOCKED_NAMESPACES = ["review:", "crawler:", "session:", "rate-limit:"];

function isAllowedPattern(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  for (const blocked of BLOCKED_NAMESPACES) {
    if (p.startsWith(blocked) || p.includes(blocked)) return false;
  }
  for (const allowed of CACHE_ALLOWLIST) {
    const re = new RegExp("^" + allowed.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    if (re.test(p)) return true;
  }
  return false;
}

export async function adminCacheRoutes(app: FastifyInstance): Promise<void> {
  const cacheService = new CacheService(app.redis);

  app.post("/cache/purge", async (req: any, reply: any) => {
    const body = (req.body as any) || {};
    const pattern = typeof body.pattern === "string" ? body.pattern : undefined;
    const paths = Array.isArray(body.paths) ? body.paths.filter((p: unknown): p is string => typeof p === "string" && p.length > 0) : [];

    if (body.purgeAll === true || (!pattern && paths.length === 0) || pattern === "*") {
      return reply.status(422).send({ success: false, error: { code: "PURGE_ALL_BLOCKED", message: "Full flush is not allowed. Use specific namespace patterns." } });
    }

    const namespaces: string[] = [];
    const keySet = new Set<string>();

    if (pattern) {
      if (!isAllowedPattern(pattern)) {
        return reply.status(422).send({ success: false, error: { code: "NAMESPACE_NOT_ALLOWED", message: `Pattern "${pattern}" is not in the allowed cache namespace list` } });
      }
      namespaces.push(pattern);
      let cursor = "0";
      do {
        const [cursor2, keys] = await app.redis.scan(cursor, "MATCH", pattern, "COUNT", "100");
        cursor = cursor2;
        for (const k of keys) keySet.add(k);
      } while (cursor !== "0");
    }

    for (const path of paths) {
      const m = path.match(/^\/figures?\/([^/]+)\/?$/);
      if (m?.[1]) {
        const detailKey = `figures:detail:${m[1]}`;
        keySet.add(detailKey);
        namespaces.push(detailKey);
      }
    }

    if (paths.length > 0) {
      namespaces.push("figures:list:*");
      let cursor2 = "0";
      do {
        const [nextCursor, scanKeys] = await app.redis.scan(cursor2, "MATCH", "figures:list:*", "COUNT", "100");
        cursor2 = nextCursor;
        for (const k of scanKeys) keySet.add(k);
      } while (cursor2 !== "0");
    }

    const keys = Array.from(keySet);
    let deleted = 0;
    if (keys.length > 0) {
      deleted = await app.redis.unlink(...keys);
    }

    return { success: true, data: { purged: true, mode: "targeted", matched: keys.length, deleted, namespaces } };
  });
}
