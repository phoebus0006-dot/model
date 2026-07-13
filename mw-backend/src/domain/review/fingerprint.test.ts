// Tests for the canonical evidence fingerprint service.
// Run: npx tsx --test src/domain/review/fingerprint.test.ts
//
// Covers:
//   - stable serialization (same data → same output)
//   - key order independence (different insertion order → same fingerprint)
//   - field change detection (any risk-relevant field change → different fp)
//   - imageIds sorted (set semantics, not order-dependent)
//   - null/undefined equivalence

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  stableSerialize,
  computeCanonicalFingerprint,
  buildEvidence,
  type CanonicalEvidence,
} from "./fingerprint";

// ─── stableSerialize ──────────────────────────────────────────────────────────

describe("stableSerialize", () => {
  test("primitive values serialize correctly", () => {
    assert.equal(stableSerialize("hello"), '"hello"');
    assert.equal(stableSerialize(42), "42");
    assert.equal(stableSerialize(true), "true");
    assert.equal(stableSerialize(false), "false");
    assert.equal(stableSerialize(null), "null");
    assert.equal(stableSerialize(undefined), "null");
  });

  test("null and undefined are equivalent", () => {
    assert.equal(stableSerialize(null), stableSerialize(undefined));
  });

  test("object keys are sorted alphabetically", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    assert.equal(stableSerialize(a), stableSerialize(b));
  });

  test("deeply nested object keys are sorted", () => {
    const a = { outer: { z: 1, a: { d: 4, b: 2 } } };
    const b = { outer: { a: { b: 2, d: 4 }, z: 1 } };
    assert.equal(stableSerialize(a), stableSerialize(b));
  });

  test("arrays preserve element order", () => {
    const a = [1, 2, 3];
    const b = [3, 2, 1];
    assert.notEqual(stableSerialize(a), stableSerialize(b));
  });

  test("array elements are sorted internally (key order)", () => {
    const a = [{ b: 2, a: 1 }];
    const b = [{ a: 1, b: 2 }];
    assert.equal(stableSerialize(a), stableSerialize(b));
  });

  test("undefined object values are skipped", () => {
    const a = { x: 1, y: undefined };
    const b = { x: 1 };
    assert.equal(stableSerialize(a), stableSerialize(b));
  });

  test("bigint serializes as decimal string", () => {
    assert.equal(stableSerialize(42n), '"42"');
    assert.equal(stableSerialize(0n), '"0"');
  });

  test("Date serializes as ISO string", () => {
    const d = new Date("2026-01-15T10:30:00.000Z");
    assert.equal(stableSerialize(d), '"2026-01-15T10:30:00.000Z"');
  });

  test("nested arrays in objects preserve order", () => {
    const a = { items: [3, 1, 2] };
    const b = { items: [3, 1, 2] };
    assert.equal(stableSerialize(a), stableSerialize(b));
    const c = { items: [1, 2, 3] };
    assert.notEqual(stableSerialize(a), stableSerialize(c));
  });
});

// ─── computeCanonicalFingerprint ──────────────────────────────────────────────

describe("computeCanonicalFingerprint", () => {
  const baseEvidence: CanonicalEvidence = {
    figureId: "286",
    riskType: "image_low_count",
    primaryImageId: "12",
    imageIds: ["12", "13", "14"],
    candidateAssetHash: "abc123def456",
    riskFields: {
      description: "Test figure",
      spec: { scale: "1/7", material: "PVC" },
      category: "anime",
    },
  };

  test("produces a 64-char lowercase hex sha256", () => {
    const fp = computeCanonicalFingerprint(baseEvidence);
    assert.equal(fp.length, 64);
    assert.match(fp, /^[0-9a-f]{64}$/);
  });

  test("same evidence → same fingerprint (stability)", () => {
    const fp1 = computeCanonicalFingerprint(baseEvidence);
    const fp2 = computeCanonicalFingerprint(baseEvidence);
    assert.equal(fp1, fp2);
  });

  test("key order in riskFields does not affect fingerprint", () => {
    const evidenceA: CanonicalEvidence = {
      ...baseEvidence,
      riskFields: { description: "Test figure", spec: { scale: "1/7", material: "PVC" }, category: "anime" },
    };
    const evidenceB: CanonicalEvidence = {
      ...baseEvidence,
      riskFields: { category: "anime", spec: { material: "PVC", scale: "1/7" }, description: "Test figure" },
    };
    assert.equal(
      computeCanonicalFingerprint(evidenceA),
      computeCanonicalFingerprint(evidenceB),
      "different key order in riskFields must produce same fingerprint",
    );
  });

  test("key order in nested spec does not affect fingerprint", () => {
    const evidenceA: CanonicalEvidence = {
      ...baseEvidence,
      riskFields: { spec: { scale: "1/7", material: "PVC", height: "250mm" } },
    };
    const evidenceB: CanonicalEvidence = {
      ...baseEvidence,
      riskFields: { spec: { height: "250mm", material: "PVC", scale: "1/7" } },
    };
    assert.equal(computeCanonicalFingerprint(evidenceA), computeCanonicalFingerprint(evidenceB));
  });

  // ── Field change detection ──

  test("figureId change → different fingerprint", () => {
    const changed = { ...baseEvidence, figureId: "287" };
    assert.notEqual(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(changed));
  });

  test("riskType change → different fingerprint", () => {
    const changed = { ...baseEvidence, riskType: "image_missing" };
    assert.notEqual(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(changed));
  });

  test("primaryImageId change → different fingerprint", () => {
    const changed = { ...baseEvidence, primaryImageId: "99" };
    assert.notEqual(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(changed));
  });

  test("imageIds set change → different fingerprint", () => {
    const changed = { ...baseEvidence, imageIds: ["12", "13", "14", "15"] };
    assert.notEqual(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(changed));
  });

  test("imageIds order change → SAME fingerprint (set semantics)", () => {
    const reordered = { ...baseEvidence, imageIds: ["14", "12", "13"] };
    assert.equal(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(reordered));
  });

  test("candidateAssetHash change → different fingerprint", () => {
    const changed = { ...baseEvidence, candidateAssetHash: "different_hash" };
    assert.notEqual(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(changed));
  });

  test("description change → different fingerprint", () => {
    const changed = {
      ...baseEvidence,
      riskFields: { ...baseEvidence.riskFields, description: "Updated description" },
    };
    assert.notEqual(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(changed));
  });

  test("spec field change → different fingerprint", () => {
    const changed = {
      ...baseEvidence,
      riskFields: { ...baseEvidence.riskFields, spec: { scale: "1/6", material: "PVC" } },
    };
    assert.notEqual(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(changed));
  });

  test("category change → different fingerprint", () => {
    const changed = {
      ...baseEvidence,
      riskFields: { ...baseEvidence.riskFields, category: "manga" },
    };
    assert.notEqual(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(changed));
  });

  test("null figureId vs string figureId → different fingerprint", () => {
    const noFig = { ...baseEvidence, figureId: null };
    assert.notEqual(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(noFig));
  });

  test("null candidateAssetHash vs non-null → different fingerprint", () => {
    const noCandidate = { ...baseEvidence, candidateAssetHash: null };
    assert.notEqual(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(noCandidate));
  });

  test("empty imageIds vs non-empty → different fingerprint", () => {
    const empty = { ...baseEvidence, imageIds: [] };
    assert.notEqual(computeCanonicalFingerprint(baseEvidence), computeCanonicalFingerprint(empty));
  });
});

// ─── buildEvidence ────────────────────────────────────────────────────────────

describe("buildEvidence", () => {
  test("builds CanonicalEvidence from flat input", () => {
    const evidence = buildEvidence({
      figureId: 42,
      riskType: "image_missing",
      primaryImageId: "5",
      imageIds: ["5", "6"],
      candidateAssetHash: "hash123",
      description: "desc",
      spec: { scale: "1/7" },
      category: "anime",
    });
    assert.equal(evidence.figureId, "42");
    assert.equal(evidence.riskType, "image_missing");
    assert.equal(evidence.primaryImageId, "5");
    assert.deepEqual(evidence.imageIds, ["5", "6"]);
    assert.equal(evidence.candidateAssetHash, "hash123");
    assert.equal(evidence.riskFields.description, "desc");
    assert.equal((evidence.riskFields.spec as Record<string, unknown>)?.scale, "1/7");
    assert.equal(evidence.riskFields.category, "anime");
  });

  test("bigint figureId converts to string", () => {
    const evidence = buildEvidence({ figureId: 286n });
    assert.equal(evidence.figureId, "286");
  });

  test("null/undefined inputs produce safe defaults", () => {
    const evidence = buildEvidence({});
    assert.equal(evidence.figureId, null);
    assert.equal(evidence.riskType, "no-risk");
    assert.equal(evidence.primaryImageId, null);
    assert.deepEqual(evidence.imageIds, []);
    assert.equal(evidence.candidateAssetHash, null);
    assert.deepEqual(evidence.riskFields, {});
  });

  test("extraRiskFields are merged into riskFields", () => {
    const evidence = buildEvidence({
      description: "desc",
      extraRiskFields: { custom: "value", another: 42 },
    });
    assert.equal(evidence.riskFields.description, "desc");
    assert.equal(evidence.riskFields.custom, "value");
    assert.equal(evidence.riskFields.another, 42);
  });
});
