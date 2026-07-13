// Integration test skeleton: crawler state transition legality.
//
// Verifies that the CrawlerJob state machine enforces legal transitions end
// to end through the repository layer against a real database, complementing
// the pure-logic unit tests in src/crawler/stateMachine.test.ts. Illegal
// transitions must throw IllegalTransitionError and must NOT persist a
// corrupted status to PostgreSQL.
//
// Requires: live PostgreSQL + Redis — NOT a unit test.
// Run: npm run test:integration

import { test, describe } from "node:test";

describe("crawler state transitions (integration)", () => {
  test.skip("created -> queued -> claimed -> running -> completed is persisted in order", () => {
    // TODO: create a job, releaseToQueued, claimJobs, start, complete, and
    // assert each persisted status matches the expected transition.
  });

  test.skip("an illegal transition (created -> running) throws and does not persist", () => {
    // TODO: attempt to start a job still in "created" and assert it throws
    // IllegalTransitionError AND the DB row remains status="created".
  });

  test.skip("failed -> created (adminRetry) resets error and increments attempts", () => {
    // TODO: fail a job, adminRetry it, and assert status="created",
    // error=null, and attempts incremented by 1.
  });

  test.skip("completed is terminal and rejects further transitions", () => {
    // TODO: complete a job then attempt releaseToQueued/start and assert
    // each throws IllegalTransitionError.
  });

  test.skip("deferred job becomes claimable only after notBefore has passed", () => {
    // TODO: defer a job with a future notBefore, assert it is not claimable,
    // advance time past notBefore, and assert it becomes claimable.
  });
});
