import { describe, it, expect, beforeAll } from "vitest";

describe("BigInt serialization", () => {
  beforeAll(() => {
    // Must match src/app.ts behavior
    Object.defineProperty(BigInt.prototype, "toJSON", {
      value: function () { return this.toString(); },
      writable: true,
      configurable: true,
    });
  });

  it("serializes BigInt to string, not number", () => {
    const unsafe = 9007199254740993n;
    const result = JSON.parse(JSON.stringify(unsafe));
    expect(result).toBe("9007199254740993");
    expect(typeof result).toBe("string");
  });

  it("does not lose precision for values > Number.MAX_SAFE_INTEGER", () => {
    // Number.MAX_SAFE_INTEGER = 9007199254740991
    // Demonstrate: BigInt → Number loses precision; BigInt → String preserves it
    const large = BigInt("9007199254740993");
    const asNumber = Number(large);
    const asString = JSON.parse(JSON.stringify(large));
    // IEEE 754: Number(9007199254740993) rounds to 9007199254740992
    expect(asNumber).toBe(9007199254740992);
    // String conversion preserves the exact BigInt value
    expect(asString).toBe("9007199254740993");
    // Confirm they differ: asNumber.toString() !== large.toString()
    expect(asNumber.toString()).toBe("9007199254740992");
    expect(large.toString()).toBe("9007199254740993");
  });

  it("handles BigInt zero correctly", () => {
    expect(JSON.parse(JSON.stringify(0n))).toBe("0");
  });

  it("handles negative BigInt", () => {
    expect(JSON.parse(JSON.stringify(-1n))).toBe("-1");
  });

  it("serializes BigInt in nested objects", () => {
    const obj = { id: 9007199254740993n, name: "test", nested: { value: 42n } };
    const json = JSON.stringify(obj);
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe("9007199254740993");
    expect(parsed.nested.value).toBe("42");
  });

  it("serializes BigInt in arrays", () => {
    const arr = [1n, 2n, 3n];
    const json = JSON.stringify(arr);
    expect(JSON.parse(json)).toEqual(["1", "2", "3"]);
  });

  it("does not affect non-BigInt JSON serialization", () => {
    const obj = { name: "hello", count: 42, active: true };
    const json = JSON.stringify(obj);
    expect(JSON.parse(json)).toEqual({ name: "hello", count: 42, active: true });
  });
});
