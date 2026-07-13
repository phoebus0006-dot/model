// Canonical evidence fingerprint service — Agent A (review-storage).
//
// Source of truth: docs/implementation/PHASE12_CONTRACT.md §8
//
// Key requirement (contract §8 + agent task):
//   - JSON serialization MUST be stable (sorted keys) so that two evidence
//     objects with the same semantic content but different key insertion order
//     produce the SAME fingerprint.
//   - The fingerprint MUST change when any risk-relevant field changes:
//       figureId, riskType, primaryImageId, imageIds set, candidate asset hash,
//       description/spec/category risk fields.
//   - Arrays preserve element order (imageIds are SORTED before hashing so set
//     semantics apply); object keys are recursively sorted.
//
// This is the enhanced canonical fingerprint used by the domain-layer
// ReviewRepository (src/domain/review/repository.ts). It is intentionally more
// comprehensive than the legacy fingerprint in src/review/repository.ts, which
// only hashed type|figureId|riskType|body.

import crypto from "node:crypto";

// ─── Stable serialization ───────────────────────────────────────────────────

/**
 * Recursively sort object keys for stable JSON serialization.
 *
 * Rules:
 *   - Objects: keys are sorted alphabetically, then serialized as
 *     `{"key1":<val1>,"key2":<val2>,...}`. Key order in the original object
 *     is irrelevant.
 *   - Arrays: element ORDER is preserved (arrays are ordered collections),
 *     but each element is recursively sorted internally. This means
 *     `[{b:1,a:2}]` and `[{a:2,b:1}]` serialize identically.
 *   - Primitives: serialized via JSON.stringify.
 *   - null/undefined: both serialize as `"null"` (treated equivalently so
 *     that a missing field and an explicit null do not fragment the
 *     fingerprint space).
 *   - bigint: converted to decimal string (no scientific notation).
 *   - Date: converted to ISO string.
 */
export function stableSerialize(value: unknown): string {
  return serializeValue(value);
}

function serializeValue(value: unknown): string {
  // null and undefined are treated equivalently
  if (value === null || value === undefined) {
    return "null";
  }
  // Primitives
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return '"NaN"';
    if (!Number.isFinite(value)) return value > 0 ? '"Infinity"' : '"-Infinity"';
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  // Arrays: preserve order, sort each element internally
  if (Array.isArray(value)) {
    const items = value.map((el) => serializeValue(el));
    return "[" + items.join(",") + "]";
  }
  // Objects: sort keys, then serialize each value
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys
      .filter((k) => obj[k] !== undefined) // skip undefined values entirely
      .map((k) => JSON.stringify(k) + ":" + serializeValue(obj[k]));
    return "{" + pairs.join(",") + "}";
  }
  // Fallback for any other type (symbol, function, etc.)
  return JSON.stringify(String(value));
}

// ─── Canonical evidence input ───────────────────────────────────────────────

/**
 * The canonical evidence used to compute the fingerprint.
 *
 * Every field here is risk-relevant: a change in ANY field MUST produce a
 * different fingerprint. Fields not listed here do NOT affect the fingerprint.
 */
export interface CanonicalEvidence {
  /** Figure identifier (decimal string of figureId, or "no-fig"). */
  figureId: string | number | null;
  /** Risk type from the canonical ReviewRiskType enum. */
  riskType: string;
  /** Primary image id (decimal string, or "no-primary" if none). */
  primaryImageId: string | number | null;
  /**
   * All active image ids for the figure. These are SORTED before hashing so
   * that the multiset identity is what matters, not insertion order.
   */
  imageIds: (string | number)[];
  /** sha256 hash of the candidate asset bytes, or null if no candidate. */
  candidateAssetHash: string | null;
  /**
   * Risk-relevant detail fields (description, spec, category, etc.).
   * Key order is irrelevant — the serializer sorts keys recursively.
   */
  riskFields: Record<string, unknown>;
}

// ─── Fingerprint computation ─────────────────────────────────────────────────

/**
 * Compute the canonical evidence fingerprint (sha256 hex, 64 chars).
 *
 * The fingerprint is a hash of the stable serialization of the CanonicalEvidence.
 * Because stableSerialize sorts keys recursively, two evidence objects with
 * the same semantic content but different key insertion order produce the
 * SAME fingerprint.
 *
 * @returns 64-char lowercase hex sha256 digest.
 */
export function computeCanonicalFingerprint(evidence: CanonicalEvidence): string {
  const figId = evidence.figureId != null ? String(evidence.figureId) : "no-fig";
  const primaryId =
    evidence.primaryImageId != null ? String(evidence.primaryImageId) : "no-primary";
  const sortedImageIds = [...evidence.imageIds].map(String).sort();
  const candidateHash = evidence.candidateAssetHash ?? "no-candidate";

  const canonical = stableSerialize({
    figureId: figId,
    riskType: evidence.riskType,
    primaryImageId: primaryId,
    imageIds: sortedImageIds,
    candidateAssetHash: candidateHash,
    riskFields: evidence.riskFields ?? {},
  });

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ─── Convenience: build evidence from a flat input ───────────────────────────

/**
 * Build a CanonicalEvidence from a loosely-typed input object.
 * This is a convenience for the repository layer so callers don't need to
 * construct the full CanonicalEvidence manually.
 */
export function buildEvidence(input: {
  figureId?: string | number | bigint | null;
  riskType?: string | null;
  primaryImageId?: string | number | null;
  imageIds?: (string | number)[] | null;
  candidateAssetHash?: string | null;
  description?: string | null;
  spec?: Record<string, unknown> | null;
  category?: string | null;
  extraRiskFields?: Record<string, unknown> | null;
}): CanonicalEvidence {
  const riskFields: Record<string, unknown> = {};
  if (input.description != null) riskFields.description = input.description;
  if (input.spec != null) riskFields.spec = input.spec;
  if (input.category != null) riskFields.category = input.category;
  if (input.extraRiskFields != null) {
    for (const [k, v] of Object.entries(input.extraRiskFields)) {
      riskFields[k] = v;
    }
  }

  return {
    figureId:
      input.figureId != null
        ? typeof input.figureId === "bigint"
          ? input.figureId.toString()
          : String(input.figureId)
        : null,
    riskType: input.riskType ?? "no-risk",
    primaryImageId: input.primaryImageId ?? null,
    imageIds: input.imageIds ?? [],
    candidateAssetHash: input.candidateAssetHash ?? null,
    riskFields,
  };
}
