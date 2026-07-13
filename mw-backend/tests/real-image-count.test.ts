// Integration test skeleton: real image count vs database.
//
// Verifies that the image count surfaced to the review UI (via
// ReviewService.computeCurrentStateSnapshot / listEnriched) matches the
// actual number of FigureImage rows stored in PostgreSQL for a given
// figure. This guards against stale Redis mirrors or eager-count bugs
// where the snapshot reports a count that disagrees with the source of
// truth.
//
// Requires: live PostgreSQL with seeded data (NOT a unit test).
// Run: npm run test:integration

import { test, describe } from "node:test";

describe("real image count matches database", () => {
  test.skip("snapshot.imageCount equals COUNT(*) from FigureImage for the figure", () => {
    // TODO: seed a figure with N images, call computeCurrentStateSnapshot,
    // and assert snapshot.imageCount === N from a direct SQL COUNT query.
  });

  test.skip("imageCount is 0 when the figure has no FigureImage rows", () => {
    // TODO: seed a figure with zero images and assert snapshot.imageCount === 0.
  });

  test.skip("imageCount reflects soft-deleted images being excluded", () => {
    // TODO: if FigureImage supports a deleted/suppressed flag, seed images
    // where some are flagged and assert only non-deleted rows are counted.
  });

  test.skip("imageCount stays consistent after a recheck (no double counting)", () => {
    // TODO: call recheckItem then re-compute the snapshot and assert the
    // count did not change spuriously.
  });
});
