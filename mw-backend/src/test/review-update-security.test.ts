import { describe, it, expect } from "vitest";
import { reviewEditableFieldsSchema } from "../modules/reviews/schemas.js";

describe("Review PUT state machine bypass fix", () => {
  describe("reviewEditableFieldsSchema.strict()", () => {
    it("allows only editable fields", () => {
      const result = reviewEditableFieldsSchema.strict().parse({ notes: "Updated note", priority: 2 });
      expect(result.notes).toBe("Updated note");
      expect(result.priority).toBe(2);
    });

    it("rejects status with ZodError when strict", () => {
      expect(() => reviewEditableFieldsSchema.strict().parse({ status: "approved" })).toThrow();
    });

    it("rejects decisionReason with ZodError when strict", () => {
      expect(() => reviewEditableFieldsSchema.strict().parse({ decisionReason: "reason" })).toThrow();
    });

    it("rejects reviewer with ZodError when strict", () => {
      expect(() => reviewEditableFieldsSchema.strict().parse({ reviewer: "admin" })).toThrow();
    });

    it("rejects decisionAt with ZodError when strict", () => {
      expect(() => reviewEditableFieldsSchema.strict().parse({ decisionAt: "2026-01-01" })).toThrow();
    });

    it("rejects action with ZodError when strict", () => {
      expect(() => reviewEditableFieldsSchema.strict().parse({ action: "approve_image" })).toThrow();
    });

    it("rejects version with ZodError when strict", () => {
      expect(() => reviewEditableFieldsSchema.strict().parse({ version: 2 })).toThrow();
    });

    it("rejects createdAt with ZodError when strict", () => {
      expect(() => reviewEditableFieldsSchema.strict().parse({ createdAt: "2026-01-01T00:00:00Z" })).toThrow();
    });

    it("rejects appliedAt with ZodError when strict", () => {
      expect(() => reviewEditableFieldsSchema.strict().parse({ appliedAt: "2026-01-01T00:00:00Z" })).toThrow();
    });

    it("rejects idempotencyKey with ZodError when strict", () => {
      expect(() => reviewEditableFieldsSchema.strict().parse({ idempotencyKey: "abc" })).toThrow();
    });

    it("rejects events with ZodError when strict", () => {
      expect(() => reviewEditableFieldsSchema.strict().parse({ events: [] })).toThrow();
    });

    it("rejects mixed allowed and forbidden fields as a whole", () => {
      expect(() => reviewEditableFieldsSchema.strict().parse({ notes: "ok", status: "approved" })).toThrow();
    });

    it("allows empty body", () => {
      const result = reviewEditableFieldsSchema.strict().parse({});
      expect(result).toEqual({});
    });

    it("allows confidence field", () => {
      const result = reviewEditableFieldsSchema.strict().parse({ confidence: 0.9 });
      expect(result.confidence).toBe(0.9);
    });

    it("allows payload field", () => {
      const result = reviewEditableFieldsSchema.strict().parse({ payload: { key: "val" } });
      expect(result.payload).toEqual({ key: "val" });
    });
  });
});
