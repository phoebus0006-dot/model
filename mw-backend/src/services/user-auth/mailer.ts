// SMTP mailer for the frontend User account system.
//
// Contract: docs/implementation/AUTH_ACCOUNT_CONTRACT.md §2.4, §2.6
//
// Rules:
//   - SMTP not configured → throw SmtpNotConfiguredError (routes return 503).
//     Registration must NOT create a User when SMTP is missing.
//   - SMTP send exception → reject (do NOT return fake success); the caller
//     keeps a resendable safe state. Raw tokens are never logged.
//   - For tests/dev, set SMTP_TRANSPORT=stub to use an in-memory stream
//     transport (no real network). Sent messages are captured for assertions.
//   - For send-failure tests, point SMTP_HOST/SMTP_PORT at an unreachable port
//     (e.g. 127.0.0.1:1) to get a deterministic ECONNREFUSED.

import nodemailer, { type Transporter } from "nodemailer";

export class SmtpNotConfiguredError extends Error {
  readonly code = "SMTP_NOT_CONFIGURED";
  constructor() {
    super("SMTP_NOT_CONFIGURED");
    this.name = "SmtpNotConfiguredError";
  }
}

export interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

// In-memory capture of sent mail. Only populated when SMTP_TRANSPORT=stub
// (test/dev). Never populated for real SMTP sends, and never written to logs.
const sentMail: SentMail[] = [];

/** Test/dev helper: inspect messages sent while SMTP_TRANSPORT=stub. */
export function getSentMail(): SentMail[] {
  return sentMail;
}

/** Test/dev helper: clear captured messages. */
export function resetSentMail(): void {
  sentMail.length = 0;
}

/** SMTP is considered configured when both host and from are set. */
export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function buildTransporter(): Transporter {
  if (process.env.SMTP_TRANSPORT === "stub") {
    return nodemailer.createTransport({ streamTransport: true, buffer: true });
  }
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  const auth =
    process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined;
  return nodemailer.createTransport({ host: host as string, port, secure, auth });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

async function send(to: string, subject: string, text: string, html: string): Promise<void> {
  if (!smtpConfigured()) throw new SmtpNotConfiguredError();
  const transporter = buildTransporter();
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text,
    html,
  });
  if (process.env.SMTP_TRANSPORT === "stub") {
    sentMail.push({ to, subject, text, html });
  }
}

export async function sendVerificationEmail(
  to: string,
  displayName: string,
  verifyUrl: string,
): Promise<void> {
  const text = [
    `Hi ${displayName},`,
    "",
    "Please activate your ModelWiki account by opening this link:",
    verifyUrl,
    "",
    "This link expires in 24 hours. If you did not create this account, you can ignore this email.",
  ].join("\n");
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222">
      <h2>Activate your ModelWiki account</h2>
      <p>Hi ${escapeHtml(displayName)},</p>
      <p>Please confirm your email address.</p>
      <p><a href="${escapeHtml(verifyUrl)}" style="display:inline-block;background:#e94560;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Activate account</a></p>
      <p style="color:#666;font-size:13px">This link expires in 24 hours. If the button does not work, copy this URL:<br>${escapeHtml(verifyUrl)}</p>
    </div>`;
  await send(to, "Activate your ModelWiki account", text, html);
}

export async function sendPasswordResetEmail(
  to: string,
  displayName: string,
  resetUrl: string,
): Promise<void> {
  const text = [
    `Hi ${displayName},`,
    "",
    "You requested a password reset for your ModelWiki account. Open this link to choose a new password:",
    resetUrl,
    "",
    "This link expires in 1 hour. If you did not request a reset, you can ignore this email.",
  ].join("\n");
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222">
      <h2>Reset your ModelWiki password</h2>
      <p>Hi ${escapeHtml(displayName)},</p>
      <p>Choose a new password using the link below.</p>
      <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#e94560;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Reset password</a></p>
      <p style="color:#666;font-size:13px">This link expires in 1 hour. If the button does not work, copy this URL:<br>${escapeHtml(resetUrl)}</p>
    </div>`;
  await send(to, "Reset your ModelWiki password", text, html);
}
