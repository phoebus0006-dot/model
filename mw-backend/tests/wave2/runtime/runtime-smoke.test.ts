// Wave 2 Runtime: startup + readiness + BigInt + log-redaction smoke tests.
//
// Mirrors src/index.ts registration using the dual-identity runtime modules
// (config, dual JWT, identity collision guard, shutdown manager) with mocked
// Prisma/Redis — NO real DB required. Verifies:
//   - app.ready() succeeds with all runtime plugins registered
//   - /health and /ready respond correctly
//   - BigInt values serialize to decimal strings
//   - the Authorization header value is redacted from logs
//
// Run: npx tsx --test tests/wave2/runtime/runtime-smoke.test.ts

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import { installRedisFlushGuard } from "../../../src/security/redisGuard.js";
import { registerBigIntSerializer } from "../../../src/plugins/bigintSerializer.js";
import { registerReadinessRoutes } from "../../../src/plugins/readiness.js";
import {
  loadRuntimeConfig,
  buildUserJwtOptions,
  buildAdminJwtOptions,
  registerIdentityCollisionGuard,
  LOG_REDACT_PATHS,
} from "../../../src/runtime/index.js";

const ENV_KEYS = ["NODE_ENV", "USER_JWT_SECRET", "ADMIN_JWT_SECRET", "MW_ALLOW_TEST_SECRETS"];
const saved: Record<string, string | undefined> = {};

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.NODE_ENV = "test";
  process.env.MW_ALLOW_TEST_SECRETS = "1";
  process.env.USER_JWT_SECRET = "startup-smoke-user-secret-32-chars-min!!";
  process.env.ADMIN_JWT_SECRET = "startup-smoke-admin-secret-32-chars-min!!";
});

after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function makePrismaMock(): any {
  return {
    $queryRaw: async () => [{ "?column?": 1 }],
    $disconnect: async () => {},
    user: { findUnique: async () => null, findFirst: async () => null },
  };
}

function makeRedisMock(): any {
  return {
    ping: async () => "PONG",
    disconnect: () => {},
    sendCommand: () => undefined,
  };
}

// A writable stream that collects pino log lines for redaction assertions.
class LogCapture extends Writable {
  lines: string[] = [];
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.lines.push(chunk.toString());
    cb();
  }
}

interface BuildOpts {
  logCapture?: LogCapture;
  // extra route registrations, invoked BEFORE app.ready()
  registerRoutes?: (app: FastifyInstance) => void;
}

async function buildRuntimeApp(opts: BuildOpts = {}): Promise<FastifyInstance> {
  const config = loadRuntimeConfig();
  const app = Fastify({
    logger: opts.logCapture
      ? {
          level: "info",
          stream: opts.logCapture,
          redact: { paths: [...LOG_REDACT_PATHS], censor: "[REDACTED]" },
        }
      : false,
    trustProxy: config.trustProxy,
  });
  const prisma = makePrismaMock();
  const redis = makeRedisMock();
  app.decorate("prisma", prisma);
  app.decorate("redis", redis);

  installRedisFlushGuard(redis as any);
  registerBigIntSerializer(app);
  registerReadinessRoutes(app);

  await app.register(cors, {
    origin: config.cors.origin,
    credentials: config.cors.credentials,
    methods: config.cors.methods,
    allowedHeaders: config.cors.allowedHeaders,
  });
  await app.register(helmet, { contentSecurityPolicy: false, frameguard: false });
  await app.register(jwt, buildUserJwtOptions(config));
  await app.register(jwt, buildAdminJwtOptions(config));
  await app.register(rateLimit, { max: config.rateLimitMax, timeWindow: config.rateLimitTimeWindow });

  registerIdentityCollisionGuard(app);

  // Register extra routes BEFORE ready (Fastify forbids route addition after
  // the instance starts listening).
  if (opts.registerRoutes) opts.registerRoutes(app);

  await app.ready();
  return app;
}

describe("runtime smoke — startup", () => {
  test("app reaches ready with dual JWT + collision guard registered", async () => {
    const app = await buildRuntimeApp();
    try {
      assert.ok(app);
      // admin namespace exposes app.jwt.admin.{sign,verify,decode}
      assert.equal(typeof (app as any).jwt.admin.sign, "function");
      assert.equal(typeof (app as any).jwt.admin.verify, "function");
    } finally {
      await app.close();
    }
  });
});

describe("runtime smoke — health & readiness", () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildRuntimeApp();
  });
  after(async () => { if (app) await app.close(); });

  test("/health returns 200 { status: ok }", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, "ok");
  });

  test("/ready returns 200 when PG + Redis are reachable (mocked)", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, "ready");
    assert.equal(res.json().checks.postgres, "ok");
    assert.equal(res.json().checks.redis, "ok");
  });
});

describe("runtime smoke — BigInt serialization", () => {
  let app: FastifyInstance;
  before(async () => {
    app = await buildRuntimeApp({
      registerRoutes: (a) => {
        a.get("/bigint-test", async () => {
          return { id: 9007199254740993n, nested: { big: 1234567890123456789n } };
        });
        a.get("/bigint-array", async () => {
          return { ids: [1n, 2n, 9999999999999999999n] };
        });
      },
    });
  });
  after(async () => { if (app) await app.close(); });

  test("BigInt in response payload is serialized as decimal string", async () => {
    const res = await app.inject({ method: "GET", url: "/bigint-test" });
    const body = res.json();
    // Values above Number.MAX_SAFE_INTEGER must be preserved as strings,
    // not truncated to a JS number.
    assert.equal(body.id, "9007199254740993");
    assert.equal(body.nested.big, "1234567890123456789");
    assert.equal(typeof body.id, "string");
  });

  test("BigInt array elements serialized as strings", async () => {
    const res = await app.inject({ method: "GET", url: "/bigint-array" });
    const body = res.json();
    assert.deepEqual(body.ids, ["1", "2", "9999999999999999999"]);
  });
});

describe("runtime smoke — log redaction", () => {
  test("Authorization header value is NOT in log output", async () => {
    const capture = new LogCapture();
    const app = await buildRuntimeApp({
      logCapture: capture,
      registerRoutes: (a) => {
        // Explicitly log the authorization header value at a path covered
        // by LOG_REDACT_PATHS ("authorization" top-level + "req.headers.authorization").
        // This makes the redact config observable: the censor "[REDACTED]"
        // must replace the secret value.
        a.get("/echo", {
          onRequest: [
            async (req: any) => {
              req.log.info(
                {
                  authorization: req.headers.authorization,
                  req: { headers: { authorization: req.headers.authorization } },
                },
                "incoming-auth",
              );
            },
          ],
        }, async () => ({ ok: true }));
      },
    });
    try {
      await app.inject({
        method: "GET",
        url: "/echo",
        headers: { authorization: "Bearer super-secret-jwt-value-123456" },
      });
      const allLogs = capture.lines.join("\n");
      // The raw secret value must NOT appear anywhere in the log output.
      assert.ok(
        !allLogs.includes("super-secret-jwt-value-123456"),
        "Authorization header value leaked into logs: " + allLogs.slice(0, 300),
      );
      // The redaction censor should appear at every redacted path.
      assert.ok(
        allLogs.includes("[REDACTED]"),
        "Expected [REDACTED] censor in logs (redact config not applied): " + allLogs.slice(0, 300),
      );
    } finally {
      await app.close();
    }
  });

  test("cookie header value is NOT in log output", async () => {
    const capture = new LogCapture();
    const app = await buildRuntimeApp({
      logCapture: capture,
      registerRoutes: (a) => {
        a.get("/echo", {
          onRequest: [
            async (req: any) => {
              // Log the cookie header explicitly to exercise the "cookie"
              // redact path.
              req.log.info({ cookie: req.headers.cookie }, "incoming-cookie");
            },
          ],
        }, async () => ({ ok: true }));
      },
    });
    try {
      await app.inject({
        method: "GET",
        url: "/echo",
        headers: { cookie: "mw_user_token=leaked-session-cookie-value" },
      });
      const allLogs = capture.lines.join("\n");
      assert.ok(
        !allLogs.includes("leaked-session-cookie-value"),
        "Cookie value leaked into logs: " + allLogs.slice(0, 300),
      );
      assert.ok(
        allLogs.includes("[REDACTED]"),
        "Expected [REDACTED] censor in logs (redact config not applied): " + allLogs.slice(0, 300),
      );
    } finally {
      await app.close();
    }
  });
});

describe("runtime smoke — dual JWT cross-token at request level", () => {
  test("request.jwtVerify rejects admin token", async () => {
    const app = await buildRuntimeApp({
      registerRoutes: (a) => {
        a.get("/user-only", {
          onRequest: [
            async (req: any, reply: any) => {
              try {
                await req.jwtVerify();
              } catch {
                reply.status(401).send({ error: { code: "INVALID_TOKEN" } });
              }
            },
          ],
        }, async () => ({ ok: true }));
      },
    });
    try {
      // Sign an admin token (aud=modelwiki-admin, ADMIN secret).
      const adminToken = (app as any).jwt.admin.sign({ adminId: "1", role: "admin", sessionVersion: 0 });
      // The user-side request.jwtVerify must reject it (aud mismatch).
      const res = await app.inject({
        method: "GET",
        url: "/user-only",
        headers: { authorization: "Bearer " + adminToken },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  test("request.adminJwtVerify rejects user token", async () => {
    const app = await buildRuntimeApp({
      registerRoutes: (a) => {
        a.get("/admin-only", {
          onRequest: [
            async (req: any, reply: any) => {
              try {
                await (req as any).adminJwtVerify();
              } catch {
                reply.status(401).send({ error: { code: "INVALID_TOKEN" } });
              }
            },
          ],
        }, async () => ({ ok: true }));
      },
    });
    try {
      // Sign a user token (aud=modelwiki-user, USER secret).
      const userToken = (app as any).jwt.sign({ userId: "1" });
      const res = await app.inject({
        method: "GET",
        url: "/admin-only",
        headers: { authorization: "Bearer " + userToken },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});
