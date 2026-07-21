// Guanli admin account creation CLI.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §3.5.
//
// Usage (interactive):
//   npx tsx scripts/admin/create-admin.ts
//
// Usage (non-interactive / CI / secure):
//   MW_ADMIN_USERNAME=ops \
//   MW_ADMIN_DISPLAY_NAME="Ops Admin" \
//   MW_ADMIN_ROLE=operator \
//   MW_ADMIN_PASSWORD='...' \
//   npx tsx scripts/admin/create-admin.ts
//
// Integrator note: the npm script entry is
//   "admin:create": "tsx scripts/admin/create-admin.ts"
// (added by the Integrator; this agent does NOT modify package.json.)
//
// Security:
//   - No default password is ever supplied.
//   - The password is never printed or logged.
//   - The hardcoded admin/admin account is refused.
//   - Existing usernames are never overwritten.
//   - An AdminAuditLog (create_admin) row is written.

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PrismaClient } from "@prisma/client";
import { createAdmin } from "../../src/services/admin-auth/createAdmin.js";
import { VALID_ADMIN_ROLES } from "../../src/plugins/admin-auth/constants.js";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** Read a line with echo suppressed (for passwords). Falls back to plain readline when not a TTY. */
async function readHidden(promptStr: string): Promise<string> {
  if (!stdin.isTTY) {
    // Piped input: no echo to suppress. Read a line.
    const rl = readline.createInterface({ input, output, terminal: false });
    output.write(promptStr);
    const answer = await rl.question("");
    rl.close();
    return answer;
  }
  const rl = readline.createInterface({ input, output, terminal: true });
  // Suppress echo of typed characters while still showing the prompt + newline.
  const orig = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    // Allow the prompt and newline through; swallow everything else (password chars).
    if (s === promptStr || s === "\r\n" || s === "\n" || s === "\r") {
      orig(s);
    }
  };
  try {
    const answer = await rl.question(promptStr);
    return answer;
  } finally {
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = orig;
    rl.close();
  }
}

async function ask(rl: readline.Interface, promptStr: string, fallback?: string): Promise<string> {
  if (fallback !== undefined) return fallback;
  return rl.question(promptStr);
}

async function collectInput() {
  const rl = readline.createInterface({ input, output, terminal: false });

  const username = await ask(rl, "Username: ", env("MW_ADMIN_USERNAME"));
  const displayName = await ask(rl, "Display name: ", env("MW_ADMIN_DISPLAY_NAME"));
  const role = await ask(rl, `Role (${VALID_ADMIN_ROLES.join("/")}): `, env("MW_ADMIN_ROLE"));

  rl.close();

  // Password: prefer env var (secure for CI); otherwise read with echo suppressed.
  let password = env("MW_ADMIN_PASSWORD");
  if (!password) {
    password = await readHidden("Password (will not be displayed): ");
  }

  return { username, displayName, role, password };
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set. Point it at the target database.");
    return 1;
  }

  const { username, displayName, role, password } = await collectInput();

  if (!username || !displayName || !role || !password) {
    console.error("ERROR: username, displayName, role, and password are all required.");
    return 1;
  }

  const prisma = new PrismaClient();
  try {
    await createAdmin(prisma, { username, displayName, role, password });
    return 0;
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
