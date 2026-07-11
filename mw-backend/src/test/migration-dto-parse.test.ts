import { describe, it, expect } from "vitest";

interface MigratedReviewItem {
  publicId: string;
  type: string;
  title: string;
  source: string | null;
  status: string;
  priority: number;
  figureId: string | null;
  figureSlug: string | null;
  riskType: string | null;
  evidenceFingerprint: string | null;
  reviewer: string | null;
  decisionReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  decisionAt: string | null;
}

const VALID_REVIEW_STATUSES = ["pending", "approved", "rejected", "needs_changes", "resolved", "stale"];

function parseRedisReview(raw: string): MigratedReviewItem {
  const parsed = JSON.parse(raw);
  const status = String(parsed.status || "pending");
  if (!VALID_REVIEW_STATUSES.includes(status) && status !== "unknown") {
    // Preserve unknown statuses
  }
  return {
    publicId: String(parsed.id || ""),
    type: String(parsed.type || "general"),
    title: String(parsed.title || ""),
    source: parsed.source ? String(parsed.source) : null,
    status,
    priority: typeof parsed.priority === "number" ? parsed.priority : 1,
    figureId: parsed.figureId != null ? String(parsed.figureId) : null,
    figureSlug: parsed.figureSlug ? String(parsed.figureSlug) : null,
    riskType: parsed.riskType ? String(parsed.riskType) : null,
    evidenceFingerprint: parsed.evidenceFingerprint ? String(parsed.evidenceFingerprint) : null,
    reviewer: parsed.reviewer ? String(parsed.reviewer) : null,
    decisionReason: parsed.decisionReason ? String(parsed.decisionReason) : null,
    notes: parsed.notes ? String(parsed.notes) : null,
    createdAt: parsed.createdAt ? String(parsed.createdAt) : new Date().toISOString(),
    updatedAt: parsed.updatedAt ? String(parsed.updatedAt) : (parsed.createdAt ? String(parsed.createdAt) : new Date().toISOString()),
    decisionAt: parsed.decisionAt ? String(parsed.decisionAt) : null,
  };
}

describe("Redis review JSON → Migration DTO", () => {
  it("parses a minimal valid item", () => {
    const raw = JSON.stringify({ id: "test-1", title: "Test" });
    const dto = parseRedisReview(raw);
    expect(dto.publicId).toBe("test-1");
    expect(dto.title).toBe("Test");
    expect(dto.type).toBe("general");
    expect(dto.status).toBe("pending");
    expect(dto.priority).toBe(1);
  });

  it("parses a full item from real format", () => {
    const raw = JSON.stringify({
      id: "1783763065585-a1b2c3",
      type: "image_review",
      title: "Image review for figure 42",
      source: "mfc",
      sourceId: "12345",
      status: "approved",
      priority: 2,
      confidence: 0.95,
      figureId: "42",
      figureSlug: "hatsune-miku",
      riskType: "image_low_count",
      evidenceFingerprint: "a".repeat(64),
      reviewer: "Admin1",
      decisionReason: "Good image",
      notes: "[2026-07-11T12:00:00Z] Admin1 管理员批准候选图",
      createdAt: "2026-07-11T10:00:00.000Z",
      updatedAt: "2026-07-11T12:00:00.000Z",
      decisionAt: "2026-07-11T12:00:00.000Z",
      payload: { figureSlug: "hatsune-miku" },
    });
    const dto = parseRedisReview(raw);
    expect(dto.publicId).toBe("1783763065585-a1b2c3");
    expect(dto.type).toBe("image_review");
    expect(dto.status).toBe("approved");
    expect(dto.figureId).toBe("42");
    expect(dto.riskType).toBe("image_low_count");
    expect(dto.evidenceFingerprint).toBe("a".repeat(64));
    expect(dto.reviewer).toBe("Admin1");
    expect(dto.createdAt).toBe("2026-07-11T10:00:00.000Z");
    expect(dto.updatedAt).toBe("2026-07-11T12:00:00.000Z");
    expect(dto.decisionAt).toBe("2026-07-11T12:00:00.000Z");
  });

  it("preserves unknown status", () => {
    const raw = JSON.stringify({ id: "x", title: "x", status: "future_status" });
    const dto = parseRedisReview(raw);
    expect(dto.status).toBe("future_status");
  });

  it("handles missing updatedAt by falling back to createdAt", () => {
    const raw = JSON.stringify({ id: "x", title: "x", createdAt: "2026-01-01T00:00:00Z" });
    const dto = parseRedisReview(raw);
    expect(dto.updatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("handles null reviewer", () => {
    const raw = JSON.stringify({ id: "x", title: "x", reviewer: null });
    const dto = parseRedisReview(raw);
    expect(dto.reviewer).toBeNull();
  });

  it("handles numeric figureId", () => {
    const raw = JSON.stringify({ id: "x", title: "x", figureId: 42 });
    const dto = parseRedisReview(raw);
    expect(dto.figureId).toBe("42");
  });

  it("handles missing figureId", () => {
    const raw = JSON.stringify({ id: "x", title: "x" });
    const dto = parseRedisReview(raw);
    expect(dto.figureId).toBeNull();
  });

  it("handles BigInt-safe figureId strings", () => {
    const raw = JSON.stringify({ id: "x", title: "x", figureId: "9007199254740993" });
    const dto = parseRedisReview(raw);
    expect(dto.figureId).toBe("9007199254740993");
  });

  it("handles notes with audit trail", () => {
    const raw = JSON.stringify({
      id: "x", title: "x",
      notes: "[2026-01-01T00:00:00Z] Admin: approve\n[2026-01-02T00:00:00Z] Admin2: reject",
    });
    const dto = parseRedisReview(raw);
    expect(dto.notes).toContain("[2026-01-01T00:00:00Z]");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseRedisReview("{invalid: json}")).toThrow();
  });

  it("handles empty payload", () => {
    const raw = JSON.stringify({ id: "x", title: "x", payload: {} });
    const dto = parseRedisReview(raw);
    expect(dto.title).toBe("x");
  });

  it("preserves evidence fingerprint exact value", () => {
    const fp = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const raw = JSON.stringify({ id: "x", title: "x", evidenceFingerprint: fp });
    const dto = parseRedisReview(raw);
    expect(dto.evidenceFingerprint).toBe(fp);
  });

  it("sets default priority when missing", () => {
    const raw = JSON.stringify({ id: "x", title: "x" });
    const dto = parseRedisReview(raw);
    expect(dto.priority).toBe(1);
  });
});
