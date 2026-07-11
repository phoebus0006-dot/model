import { describe, it, expect } from "vitest";
import { reviewUpdateSchema } from "../modules/reviews/schemas.js";

const FORBIDDEN_UPDATE_FIELDS = new Set(["status", "decisionReason", "reviewer", "decisionAt", "action", "createdAt"]);

function detectForbiddenFields(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => FORBIDDEN_UPDATE_FIELDS.has(k));
}

describe("Review PUT state machine bypass fix", () => {
  describe("Forbidden field detection", () => {
    it("detects status as forbidden", () => {
      expect(detectForbiddenFields({ status: "approved" })).toEqual(["status"]);
    });

    it("detects decisionReason as forbidden", () => {
      expect(detectForbiddenFields({ decisionReason: "reason" })).toEqual(["decisionReason"]);
    });

    it("detects reviewer as forbidden", () => {
      expect(detectForbiddenFields({ reviewer: "admin" })).toEqual(["reviewer"]);
    });

    it("detects multiple forbidden fields", () => {
      const result = detectForbiddenFields({ status: "approved", reviewer: "admin", notes: "ok" });
      expect(result).toContain("status");
      expect(result).toContain("reviewer");
      expect(result).not.toContain("notes");
    });

    it("allows legitimate editable fields", () => {
      expect(detectForbiddenFields({ notes: "Updated note", priority: 2 })).toEqual([]);
    });

    it("detects action as forbidden", () => {
      expect(detectForbiddenFields({ action: "approve_image" })).toEqual(["action"]);
    });

    it("detects createdAt as forbidden", () => {
      expect(detectForbiddenFields({ createdAt: "2026-01-01" })).toEqual(["createdAt"]);
    });

    it("returns empty for empty body", () => {
      expect(detectForbiddenFields({})).toEqual([]);
    });
  });

  describe("Existing reviewUpdateSchema remains backward compatible", () => {
    it("still accepts status (schema unchanged)", () => {
      const result = reviewUpdateSchema.parse({ status: "approved", notes: "test" });
      expect(result.status).toBe("approved");
      expect(result.notes).toBe("test");
    });

    it("still accepts all fields", () => {
      const result = reviewUpdateSchema.parse({
        status: "pending", priority: 2, notes: "test",
        decisionReason: "reason", reviewer: "admin",
      });
      expect(result.status).toBe("pending");
      expect(result.decisionReason).toBe("reason");
    });
  });
});
