// Credential helpers for the frontend User account system.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §2.1, §2.4, §2.3
//
// Password strength (FROZEN — must NOT be relaxed):
//   - at least 8 characters
//   - at least 1 uppercase letter
//   - at least 1 lowercase letter
//   - at least 1 special character (NOT "digit or special" — special required)
//
// Tokens (email verification + password reset):
//   - 32 random bytes, base64url encoded
//   - DB stores only SHA-256(token); the raw token is NEVER persisted or logged

import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
const BCRYPT_COST = 12;

const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;
const HAS_SPECIAL = /[^A-Za-z0-9]/;

/** Describe which strength requirements a password fails. */
export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) issues.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH) issues.push(`at most ${PASSWORD_MAX_LENGTH} characters`);
  if (!HAS_UPPER.test(password)) issues.push("at least 1 uppercase letter");
  if (!HAS_LOWER.test(password)) issues.push("at least 1 lowercase letter");
  if (!HAS_SPECIAL.test(password)) issues.push("at least 1 special character");
  return issues;
}

/** Zod schema enforcing the full password strength policy. */
export const passwordSchema = z.string().superRefine((password, ctx) => {
  const issues = passwordIssues(password);
  if (issues.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Password does not meet strength requirements: ${issues.join(", ")}`,
    });
  }
});

/** Hash a password with bcrypt (cost factor 12). */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/** Verify a plaintext password against a bcrypt hash. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

/** Generate a 32-byte random token, base64url encoded (for verification/reset). */
export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Hash a token with SHA-256 (only the hash is stored in the DB). */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
