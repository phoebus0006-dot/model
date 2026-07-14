// Integration test skeleton: review item reopen logic.
//
// Verifies that a resolved/archived ReviewItem can be reopened when the
// underlying condition regresses (e.g. a figure that had its images fixed
// later loses them again). Reopen must transition the item back to a
// pending/needs_changes state and must not silently clobber the prior
// audit history.
//
// Requires: live PostgreSQL + Redis — NOT a unit test.
// Run: npm run test:integration

import { test, describe } from "node:test";

describe("review item reopen", () => {
  test.skip("a resolved ReviewItem can be reopened to pending", () => {
    // TODO: resolve an item, then call reopen and assert status === "pending".
  });

  test.skip("reopen appends a new ReviewDecision rather than mutating the old one", () => {
    // TODO: reopen an item and assert a NEW ReviewDecision row is created
    // with action="reopen" while the prior decision row is unchanged.
  });

  test.skip("reopen re-evaluates current state (recheck) before flipping status", () => {
    // TODO: reopen an item whose underlying issue is actually resolved and
    // assert it is not flipped to pending (no-op reopen).
  });

  test.skip("reopen on a terminal/archived item is allowed exactly once per cycle", () => {
    // TODO: assert that reopening an already-pending item is a no-op or
    // throws a clear error rather than creating churn.
  });
});
