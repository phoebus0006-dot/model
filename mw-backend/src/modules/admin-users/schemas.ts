import { z } from "zod";

export const updateUserSchema = z.object({
  displayName: z.string().min(1).optional(),
  role: z.enum(["admin", "editor", "viewer"]).optional(),
  isActive: z.boolean().optional(),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  displayName: z.string().min(1),
  role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
});

export const passwordUpdateSchema = z.object({ newPassword: z.string().min(1) });

export function safeBigInt(value: string): bigint | null {
  try {
    if (!/^-?\d+$/.test(value)) return null;
    return BigInt(value);
  } catch {
    return null;
  }
}

export function isValidPassword(pwd: string): boolean {
  if (!pwd || typeof pwd !== "string") return false;
  if (pwd.length < 8 || pwd.length > 128) return false;
  if (!/[A-Z]/.test(pwd)) return false;
  if (!/[a-z]/.test(pwd)) return false;
  if (!/[^A-Za-z0-9]/.test(pwd)) return false;
  return true;
}
