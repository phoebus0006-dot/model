// Integration test skeleton: duplicate evidence suppression.
//
// Verifies that when the crawler emits evidence identical to an existing
// ReviewItem (same evidenceFingerprint), the duplicate is suppressed rather
// than creating a second open ReviewItem. This prevents the review queue
// from filling with redundant work for the same underlying issue.
//
// Requires: live PostgreSQL + Redis (evidenceFingerprint dedup) — NOT a unit test.
// Run: npm run test:integration

import { test, describe } from "node:test";

describe("duplicate evidence suppression", () => {
  test.skip("identical evidence fingerprint does not create a second ReviewItem", () => {
    // TODO: enqueue evidence with fingerprint F, then enqueue the same F
    // again and assert only ONE ReviewItem with that fingerprint exists.
  });

  test.skip("suppressed duplicate is recorded as a no-op, not an error", () => {
    // TODO: assert the suppression is logged/metriced but does not throw.
  });

  test.skip("different fingerprint for the same figure creates a separate ReviewItem", () => {
    // TODO: enqueue evidence with fingerprint F1 and F2 for the same figureId
    // and assert two distinct ReviewItems are created.
  });

  test.skip("a resolved ReviewItem with the same fingerprint is not re-opened by a duplicate", () => {
    // TODO: resolve a ReviewItem, then re-enqueue identical evidence and
    // assert the resolved item is not flipped back to pending.
  });
});
