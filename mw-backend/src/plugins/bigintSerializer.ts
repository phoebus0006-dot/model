// Phase 1+2 runtime-security: BigInt → string serialization.
//
// Problem: Prisma returns BigInt for BigInt columns (User.id, Figure.id, etc.).
// The previous solution globally patched BigInt.prototype.toJSON to return
// Number(this), which silently truncates IDs > Number.MAX_SAFE_INTEGER
// (2^53 - 1 = 9007199254740991). A future auto-increment ID above that value
// would be silently corrupted in every API response.
//
// Fix: remove the global toJSON patch and instead convert BigInt values to
// decimal strings at the Fastify serialization layer (preSerialization hook).
// This preserves full precision for any BigInt value.
//
// Contract: docs/implementation/PHASE12_CONTRACT.md (BigInt integrity)
// Run tests: npx tsx --test src/plugins/bigint-serialization.test.ts

import type { FastifyInstance } from "fastify";

/**
 * Recursively convert every BigInt value in an object tree to a decimal
 * string. Handles plain objects, arrays, Maps, Sets, Date (preserved),
 * Buffer (preserved), and primitives. Returns a new tree — does not mutate
 * the input.
 */
export function convertBigIntToString(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(convertBigIntToString);
  if (typeof value !== "object") return value;
  // Preserve types that JSON.stringify handles natively
  if (value instanceof Date) return value;
  if (value instanceof Buffer) return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      out[String(k)] = convertBigIntToString(v);
    }
    return out;
  }
  if (value instanceof Set) {
    return Array.from(value).map(convertBigIntToString);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = convertBigIntToString((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * Install a preSerialization hook on a Fastify instance that converts every
 * BigInt in the response payload to a decimal string BEFORE the default
 * JSON.stringify runs. This prevents JSON.stringify from throwing on BigInt
 * (which it does by default) and preserves full precision.
 *
 * The hook only runs for object payloads — strings, Buffers, and streams
 * pass through untouched.
 */
export function registerBigIntSerializer(app: FastifyInstance): void {
  app.addHook("preSerialization", async (_req: any, _reply: any, payload: any) => {
    if (payload === null || payload === undefined) return payload;
    if (typeof payload !== "object") return payload;
    if (payload instanceof Buffer) return payload;
    if (typeof payload.pipe === "function") return payload; // stream
    return convertBigIntToString(payload);
  });
}
