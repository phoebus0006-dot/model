import { describe, it, expect } from "vitest";
import { parseRedisReviewToDTO, parseRedisDecisionToEvent } from "../modules/reviews/migration/redis-review-parser.js";
import { reconcile } from "../modules/reviews/migration/reconciliation.js";
import type { ParsedReviewItem } from "../modules/reviews/migration/migration-types.js";

describe("Redis review parser", () => {
  it("parses a minimal pending item", () => {
    const { item } = parseRedisReviewToJSON({ id: "test-1", title: "Test" }, "review:item:test-1");
    expect(item.publicId).toBe("test-1");
    expect(item.status).toBe("pending");
    expect(item.priority).toBe(1);
  });

  it("parses a full approved item with BigInt figureId", () => {
    const { item } = parseRedisReviewToJSON(
      { id: "123", title: "Test", type: "image_review", status: "approved", figureId: "9007199254740993", reviewer: "Admin", evidenceFingerprint: "a".repeat(64), createdAt: "2026-01-01T00:00:00Z" },
      "review:item:123"
    );
    expect(item.status).toBe("approved");
    expect(item.figureId).toBe(9007199254740993n);
    expect(item.reviewer).toBe("Admin");
  });

  it("preserves unknown status", () => {
    const { item } = parseRedisReviewToJSON({ id: "x", title: "x", status: "future_status" }, "review:item:x");
    expect(item.status).toBe("future_status");
  });

  it("falls back updatedAt to createdAt when missing", () => {
    const { item } = parseRedisReviewToJSON({ id: "x", title: "x", createdAt: "2026-01-01T00:00:00Z" }, "review:item:x");
    expect(item.updatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("uses system actor when reviewer missing", () => {
    const { item } = parseRedisReviewToJSON({ id: "x", title: "x" }, "review:item:x");
    expect(item.reviewer).toBe("system");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseRedisReviewToJSON("not json", "review:item:bad")).toThrow();
  });

  it("rejects non-object JSON", () => {
    expect(() => parseRedisReviewToJSON("null", "review:item:null")).toThrow();
    expect(() => parseRedisReviewToJSON('"string"', "review:item:s")).toThrow();
  });

  it("handles numeric figureId from Redis", () => {
    const { item } = parseRedisReviewToJSON({ id: "x", title: "x", figureId: 42 }, "review:item:x");
    expect(item.figureId).toBe(42n);
  });

  it("handles null figureId gracefully", () => {
    const { item } = parseRedisReviewToJSON({ id: "x", title: "x" }, "review:item:x");
    expect(item.figureId).toBeNull();
  });

  it("stores original Redis key", () => {
    const { item } = parseRedisReviewToJSON({ id: "x", title: "x" }, "review:item:x");
    expect(item.originalRedisKey).toBe("review:item:x");
  });

  it("does not lose precision on BigInt figureId", () => {
    const bigId = "9223372036854775807";
    const { item } = parseRedisReviewToJSON({ id: "x", title: "x", figureId: bigId }, "review:item:x");
    expect(String(item.figureId)).toBe(bigId);
  });

  it("reports warnings for unknown status", () => {
    const { warnings } = parseRedisReviewToJSON({ id: "x", title: "x", status: "completely_unknown" }, "review:item:x");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("Unknown status");
  });

  it("reports warnings for missing actor", () => {
    const { warnings } = parseRedisReviewToJSON({ id: "x", title: "x" }, "review:item:x");
    const actorWarnings = warnings.filter((w) => w.includes("actor"));
    expect(actorWarnings.length).toBeGreaterThan(0);
  });

  it("preserves evidence fingerprint exactly", () => {
    const fp = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const { item } = parseRedisReviewToJSON({ id: "x", title: "x", evidenceFingerprint: fp }, "review:item:x");
    expect(item.evidenceFingerprint).toBe(fp);
  });
});

describe("Redis decision parser", () => {
  it("parses a suppression decision", () => {
    const event = parseRedisDecisionToEvent(
      JSON.stringify({ reviewItemId: "item-1", action: "approve", status: "approved", reviewer: "Admin", decisionReason: "Looks good", decisionAt: "2026-01-01T00:00:00Z" }),
      "review:decision:id:42:image_low_count:abc"
    );
    expect(event).not.toBeNull();
    expect(event!.action).toBe("approve");
    expect(event!.event).toBe("suppression");
  });

  it("returns null on invalid JSON", () => {
    const event = parseRedisDecisionToEvent("not json", "review:decision:x");
    expect(event).toBeNull();
  });
});

describe("Reconciliation", () => {
  function makeRedisItem(key: string, status: string, fp?: string): ParsedReviewItem {
    return {
      originalRedisKey: key, publicId: key.split(":").pop() || "", type: "general", title: "x",
      source: null, sourceId: null, status, priority: 1, confidence: null,
      figureId: null, figureSlug: null, riskType: null, riskReason: null,
      suggestedAction: null, evidenceFingerprint: fp || null,
      reviewer: "system", decisionReason: null, decisionAt: null,
      redisFormatVersion: 1, payload: null, notes: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    };
  }

  it("reports full match when all keys match", () => {
    const redisItems = new Map<string, ParsedReviewItem>();
    redisItems.set("review:item:a", makeRedisItem("review:item:a", "pending"));
    const pgItems = new Map<string, any>();
    pgItems.set("review:item:a", { publicId: "a", status: "pending", evidenceFingerprint: null, createdAt: new Date() });
    const result = reconcile(redisItems, pgItems);
    expect(result.keyMatch).toBe(1);
    expect(result.keyMissingInPg).toBe(0);
    expect(result.statusMatch).toBe(1);
  });

  it("reports missing keys in PG", () => {
    const redisItems = new Map<string, ParsedReviewItem>();
    redisItems.set("review:item:a", makeRedisItem("review:item:a", "pending"));
    redisItems.set("review:item:b", makeRedisItem("review:item:b", "approved"));
    const pgItems = new Map<string, any>();
    pgItems.set("review:item:a", { publicId: "a", status: "pending", evidenceFingerprint: null, createdAt: new Date() });
    const result = reconcile(redisItems, pgItems);
    expect(result.keyMissingInPg).toBe(1);
  });

  it("reports status mismatches", () => {
    const redisItems = new Map<string, ParsedReviewItem>();
    redisItems.set("review:item:a", makeRedisItem("review:item:a", "pending"));
    const pgItems = new Map<string, any>();
    pgItems.set("review:item:a", { publicId: "a", status: "approved", evidenceFingerprint: null, createdAt: new Date() });
    const result = reconcile(redisItems, pgItems);
    expect(result.statusMismatch.length).toBe(1);
  });

  it("calculates match rate correctly", () => {
    const redisItems = new Map<string, ParsedReviewItem>();
    redisItems.set("review:item:a", makeRedisItem("review:item:a", "pending"));
    redisItems.set("review:item:b", makeRedisItem("review:item:b", "approved"));
    const pgItems = new Map<string, any>();
    pgItems.set("review:item:a", { publicId: "a", status: "pending", evidenceFingerprint: null, createdAt: new Date() });
    pgItems.set("review:item:b", { publicId: "b", status: "approved", evidenceFingerprint: null, createdAt: new Date() });
    const result = reconcile(redisItems, pgItems);
    expect(result.matchRate).toBe(100);
  });
});

function parseRedisReviewToJSON(input: any, key: string) {
  return parseRedisReviewToDTO(JSON.stringify(input), key);
}
