// Integration test skeleton: review action audit trail.
//
// Verifies that every review action (approve_image, reject_image,
// request_refetch, etc.) creates a persisted ReviewDecision record that
// captures who acted, when, why, and against which ReviewItem. This is the
// audit trail required by the content-governance contract so that every
// state change is attributable and replayable.
//
// Requires: live PostgreSQL (ReviewDecision table) — NOT a unit test.
// Run: npm run test:integration

import { test, describe } from "node:test";

describe("review action audit trail", () => {
  test.skip("applyAction(approve_image) creates a ReviewDecision with action=approve_image", () => {
    // TODO: invoke applyAction then query ReviewDecision by reviewItemId and
    // assert a row exists with action="approve_image" and status="resolved".
  });

  test.skip("ReviewDecision records reviewerId and reviewerRole", () => {
    // TODO: act as reviewerId=5 role=admin and assert the persisted decision
    // row carries reviewerId=5 and reviewerRole="admin".
  });

  test.skip("ReviewDecision stores decisionReason when provided", () => {
    // TODO: pass decisionReason="low resolution" and assert it is persisted.
  });

  test.skip("request_refetch audit entry links the created CrawlerJob", () => {
    // TODO: after request_refetch, assert the ReviewDecision metadata or
    // linked crawlerJobId references the newly created CrawlerJob id.
  });

  test.skip("no action leaves the audit table untouched (idempotent skip)", () => {
    // TODO: when applyAction is a no-op (e.g. keep_pending on an already
    // pending item), assert no spurious ReviewDecision row is created.
  });
});
