// Test skeleton: BigInt serialization to decimal strings.
//
// Prisma returns BigInt columns (ids, priceJpy, etc.) as JS BigInt values.
// JSON.stringify cannot serialize BigInt by default (throws TypeError), so
// the API layer must serialize BigInt values as decimal strings before
// sending responses. This test verifies that contract: every BigInt field
// surfaced to clients is rendered as a base-10 string, never as a native
// BigInt or exponential/suffixed form.
//
// Run: npm run test:integration  (kept here so it runs alongside the suite)

import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("BigInt serialization to decimal strings", () => {
  test.skip("figureId (BigInt) is serialized as a decimal string in API responses", () => {
    // TODO: once the response serializer is wired, assert that a figure with
    // id=100n is emitted as "100" (string), not 100n or 100.
  });

  test.skip("priceJpy (BigInt) is serialized as a decimal string, not exponential", () => {
    // TODO: assert a large priceJpy (e.g. 12345678n) serializes to
    // "12345678" and never to an exponential or BigInt-suffixed form.
  });

  test("BigInt(100).toString(10) === '100' (reference behavior)", () => {
    // Sanity check documenting the expected decimal-string contract.
    assert.equal(BigInt(100).toString(10), "100");
  });

  test("JSON.stringify with BigInt replacer renders decimal strings", () => {
    // Reference implementation of the contract: a replacer that converts
    // BigInt to its decimal string form must keep JSON.stringify usable.
    const replacer = (_k: string, v: unknown) =>
      typeof v === "bigint" ? v.toString(10) : v;
    const out = JSON.stringify({ id: 100n, price: 9999n }, replacer);
    assert.equal(out, '{"id":"100","price":"9999"}');
  });

  test.skip("no BigInt reaches the wire unserialized (response smoke)", () => {
    // TODO: hit a real admin/list endpoint and assert the response body
    // contains no TypeError-from-BigInt and every id field is a string.
  });
});
