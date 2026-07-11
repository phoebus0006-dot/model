import { describe, it, expect } from "vitest";
import { resolveReviewStoreMode, REVIEW_STORE_MODES } from "../modules/reviews/store-interface.js";

describe("ReviewStoreMode selection", () => {
  it("defaults to redis when env is not set", () => {
    expect(resolveReviewStoreMode(undefined)).toBe("redis");
  });

  it("defaults to redis when env is empty", () => {
    expect(resolveReviewStoreMode("")).toBe("redis");
  });

  it("accepts 'redis'", () => {
    expect(resolveReviewStoreMode("redis")).toBe("redis");
  });

  it("accepts 'dual'", () => {
    expect(resolveReviewStoreMode("dual")).toBe("dual");
  });

  it("accepts 'postgres'", () => {
    expect(resolveReviewStoreMode("postgres")).toBe("postgres");
  });

  it("accepts case-insensitive input", () => {
    expect(resolveReviewStoreMode("DuAl")).toBe("dual");
    expect(resolveReviewStoreMode("REDIS")).toBe("redis");
  });

  it("trims whitespace", () => {
    expect(resolveReviewStoreMode("  postgres  ")).toBe("postgres");
  });

  it("throws on invalid mode", () => {
    expect(() => resolveReviewStoreMode("mongo")).toThrow("Invalid REVIEW_STORE_MODE");
  });

  it("throws on nullish values with string type", () => {
    expect(() => resolveReviewStoreMode("null")).toThrow("Invalid REVIEW_STORE_MODE");
  });

  it("all valid modes are in the const array", () => {
    expect(REVIEW_STORE_MODES).toContain("redis");
    expect(REVIEW_STORE_MODES).toContain("dual");
    expect(REVIEW_STORE_MODES).toContain("postgres");
  });
});
