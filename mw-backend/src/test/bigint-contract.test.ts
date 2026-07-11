import { describe, it, expect, beforeAll } from "vitest";

describe("BigInt serialization — contract compatibility", () => {
  beforeAll(() => {
    Object.defineProperty(BigInt.prototype, "toJSON", {
      value: function () { return this.toString(); },
      writable: true,
      configurable: true,
    });
  });

  it("API response with BigInt IDs returns string IDs", () => {
    const response = {
      success: true,
      data: {
        id: 42n,
        slug: "test-figure",
        manufacturerId: 9007199254740993n,
      },
    };
    const json = JSON.stringify(response);
    const parsed = JSON.parse(json);
    expect(parsed.data.id).toBe("42");
    expect(parsed.data.manufacturerId).toBe("9007199254740993");
  });

  it("internal db id 1n serializes as '1'", () => {
    expect(JSON.parse(JSON.stringify({ id: 1n })).id).toBe("1");
  });

  it("nested BigInt in related entities", () => {
    const figureDetail = {
      id: 100n,
      series: { id: 5n, name: "Test Series" },
      characters: [{ character: { id: 10n } }],
    };
    const parsed = JSON.parse(JSON.stringify(figureDetail));
    expect(parsed.id).toBe("100");
    expect(parsed.series.id).toBe("5");
    expect(parsed.characters[0].character.id).toBe("10");
  });
});
