import { describe, it, expect } from "vitest";

type WriteResult = { pg: boolean; redis: boolean };
type Decision = "success" | "degraded" | "retry" | "failed";

function dualWriteDecision(result: WriteResult): Decision {
  if (result.pg && result.redis) return "success";
  if (result.pg && !result.redis) return "degraded";
  if (!result.pg && result.redis) return "retry";
  return "failed";
}

describe("Dual-write failure matrix", () => {
  const cases: Array<{ result: WriteResult; expected: Decision }> = [
    { result: { pg: true, redis: true }, expected: "success" },
    { result: { pg: true, redis: false }, expected: "degraded" },
    { result: { pg: false, redis: true }, expected: "retry" },
    { result: { pg: false, redis: false }, expected: "failed" },
  ];

  for (const c of cases) {
    it(`PG=${c.result.pg} Redis=${c.result.redis} → ${c.expected}`, () => {
      expect(dualWriteDecision(c.result)).toBe(c.expected);
    });
  }
});
