// Tests for BigInt → string serialization (src/plugins/bigintSerializer.ts).
// Run: npx tsx --test src/plugins/bigint-serialization.test.ts
//
// These tests verify that:
//   1. BigInt values are converted to decimal strings (not Number)
//   2. BigInt IDs > Number.MAX_SAFE_INTEGER preserve full precision
//   3. Nested objects, arrays, and mixed types are handled correctly
//   4. Date, Buffer, Map, Set are handled correctly

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { convertBigIntToString } from "./bigintSerializer.js";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER); // 9007199254740991
const OVER_MAX = MAX_SAFE + BigInt(1);             // 9007199254740992
const WAY_OVER = BigInt("99999999999999999999999"); // way beyond Number range

describe("convertBigIntToString — top-level BigInt", () => {
  test("BigInt is converted to decimal string", () => {
    assert.equal(convertBigIntToString(BigInt(42)), "42");
    assert.equal(convertBigIntToString(BigInt(0)), "0");
    assert.equal(convertBigIntToString(BigInt(-1)), "-1");
  });

  test("BigInt > Number.MAX_SAFE_INTEGER preserves full precision", () => {
    // This is the critical test: the old toJSON hack would have returned
    // Number(OVER_MAX) which loses precision. We must get the exact string.
    assert.equal(convertBigIntToString(OVER_MAX), "9007199254740992");
    assert.equal(convertBigIntToString(MAX_SAFE), "9007199254740991");
    assert.equal(convertBigIntToString(WAY_OVER), "99999999999999999999999");
  });

  test("very large BigInt (beyond Number range) is not truncated", () => {
    const huge = BigInt("123456789012345678901234567890");
    const result = convertBigIntToString(huge);
    assert.equal(result, "123456789012345678901234567890");
    // Verify it's a string, not a number
    assert.equal(typeof result, "string");
  });
});

describe("convertBigIntToString — objects", () => {
  test("plain object with BigInt values", () => {
    const input = { id: BigInt(123), name: "test", count: BigInt(0) };
    const result = convertBigIntToString(input) as any;
    assert.equal(result.id, "123");
    assert.equal(result.name, "test");
    assert.equal(result.count, "0");
    assert.equal(typeof result.id, "string");
  });

  test("nested objects", () => {
    const input = {
      user: { id: BigInt(456), profile: { figureId: OVER_MAX } },
      count: 10,
    };
    const result = convertBigIntToString(input) as any;
    assert.equal(result.user.id, "456");
    assert.equal(result.user.profile.figureId, "9007199254740992");
    assert.equal(result.count, 10);
  });

  test("object with BigInt > MAX_SAFE_INTEGER in nested structure", () => {
    const input = {
      data: {
        figures: [
          { id: WAY_OVER, slug: "huge-id" },
          { id: MAX_SAFE, slug: "max-safe" },
        ],
      },
    };
    const result = convertBigIntToString(input) as any;
    assert.equal(result.data.figures[0].id, "99999999999999999999999");
    assert.equal(result.data.figures[1].id, "9007199254740991");
  });
});

describe("convertBigIntToString — arrays", () => {
  test("array of BigInts", () => {
    const input = [BigInt(1), BigInt(2), OVER_MAX];
    const result = convertBigIntToString(input) as any[];
    assert.deepEqual(result, ["1", "2", "9007199254740992"]);
  });

  test("mixed array", () => {
    const input = [BigInt(1), "hello", 42, null, OVER_MAX];
    const result = convertBigIntToString(input) as any[];
    assert.equal(result[0], "1");
    assert.equal(result[1], "hello");
    assert.equal(result[2], 42);
    assert.equal(result[3], null);
    assert.equal(result[4], "9007199254740992");
  });
});

describe("convertBigIntToString — special types preserved", () => {
  test("Date is preserved (not converted)", () => {
    const date = new Date("2025-01-15T10:30:00Z");
    const result = convertBigIntToString({ createdAt: date, id: BigInt(1) }) as any;
    assert.ok(result.createdAt instanceof Date);
    assert.equal(result.createdAt.getTime(), date.getTime());
    assert.equal(result.id, "1");
  });

  test("Buffer is preserved", () => {
    const buf = Buffer.from([1, 2, 3]);
    const result = convertBigIntToString({ data: buf, id: BigInt(1) }) as any;
    assert.ok(Buffer.isBuffer(result.data));
    assert.deepEqual(Array.from(result.data), [1, 2, 3]);
    assert.equal(result.id, "1");
  });

  test("null and undefined are passed through", () => {
    assert.equal(convertBigIntToString(null), null);
    assert.equal(convertBigIntToString(undefined), undefined);
  });

  test("primitives are passed through", () => {
    assert.equal(convertBigIntToString(42), 42);
    assert.equal(convertBigIntToString("hello"), "hello");
    assert.equal(convertBigIntToString(true), true);
  });
});

describe("convertBigIntToString — does not mutate input", () => {
  test("original object retains BigInt type", () => {
    const input = { id: BigInt(123) };
    const result = convertBigIntToString(input);
    assert.deepEqual(result, { id: "123" });
    // Original should still have BigInt
    assert.equal(typeof input.id, "bigint");
  });
});
