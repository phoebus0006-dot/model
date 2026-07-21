// Email normalization for the frontend User account system.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §2.5
//
// Rules (MANDATORY — no provider-specific rewriting):
//   ✅ trim whitespace
//   ✅ domain lowercase
//   ✅ IDN domain standardization (Punycode via node:url domainToASCII)
//   ✅ basic format validation (exactly one "@", non-empty local + domain)
//   ❌ NOT Gmail dot-removal
//   ❌ NOT +tag removal
//   ❌ NOT local part case folding
//
// `email` is the trimmed original; `normalizedEmail` is used for uniqueness.

import { domainToASCII } from "node:url";

export interface NormalizedEmail {
  /** Trimmed original email exactly as entered by the user. */
  email: string;
  /** Normalized form used for uniqueness checking. */
  normalizedEmail: string;
}

/**
 * Basic structural validation of an email address. Does NOT attempt full RFC
 * validation — only the contract's requirements: exactly one "@", non-empty
 * local and domain parts, domain contains a dot, no whitespace, sane length.
 */
export function isValidEmailFormat(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  const atCount = (trimmed.match(/@/g) || []).length;
  if (atCount !== 1) return false;
  const atIdx = trimmed.lastIndexOf("@");
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes(".")) return false;
  if (/\s/.test(local) || /\s/.test(domain)) return false;
  return true;
}

/**
 * Normalize an email per AUTH_ACCOUNT_CONTRACT §2.5.
 *
 * Local part is preserved EXACTLY as entered (case-sensitive, dots and +tags
 * kept). Domain is lowercased and, if it contains non-ASCII characters,
 * converted to Punycode via IDNA (domainToASCII).
 *
 * Returns null if the input is not a valid email format.
 */
export function normalizeEmail(raw: string): NormalizedEmail | null {
  if (!isValidEmailFormat(raw)) return null;
  const trimmed = (raw as string).trim();
  const atIdx = trimmed.lastIndexOf("@");
  const local = trimmed.slice(0, atIdx);
  const rawDomain = trimmed.slice(atIdx + 1);

  let domain: string;
  if (/[^\x00-\x7F]/.test(rawDomain)) {
    // IDN domain: lowercase then convert to Punycode (IDNA2008-ish via ICU).
    const ascii = domainToASCII(rawDomain.toLowerCase());
    if (!ascii) return null;
    domain = ascii;
  } else {
    domain = rawDomain.toLowerCase();
  }

  if (!domain || !domain.includes(".")) return null;

  return { email: trimmed, normalizedEmail: `${local}@${domain}` };
}
