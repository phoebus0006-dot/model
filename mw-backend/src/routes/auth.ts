import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import nodemailer from "nodemailer";

const PASSWORD_RULES = {
  minLength: 8,
  maxLength: 128,
  upper: /[A-Z]/,
  lower: /[a-z]/,
  special: /[^A-Za-z0-9]/,
};

function passwordIssues(password: string) {
  const issues: string[] = [];
  if (password.length < PASSWORD_RULES.minLength) issues.push(`至少 ${PASSWORD_RULES.minLength} 个字符`);
  if (password.length > PASSWORD_RULES.maxLength) issues.push(`不能超过 ${PASSWORD_RULES.maxLength} 个字符`);
  if (!PASSWORD_RULES.upper.test(password)) issues.push("至少 1 个大写字母");
  if (!PASSWORD_RULES.lower.test(password)) issues.push("至少 1 个小写字母");
  if (!PASSWORD_RULES.special.test(password)) issues.push("至少 1 个特殊字符");
  return issues;
}

const passwordSchema = z.string().superRefine((password, ctx) => {
  const issues = passwordIssues(password);
  if (issues.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `密码强度不足：${issues.join("、")}`,
    });
  }
});

const registerSchema = z.object({
  username: z.string().trim().min(1).max(40),
  password: passwordSchema,
  website: z.string().max(0).optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,  // 安全：复用前端相同的强度规则
});

const verifyEmailSchema = z.object({
  token: z.string().min(24),
});

function clientIp(req: any) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || "unknown";
}

function tokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function siteUrl(req: any) {
  const configured = process.env.SITE_URL || process.env.MW_SITE_URL || process.env.PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "www.phoebusstudio.com";
  return `${proto}://${host}`.replace(/\/$/, "");
}

async function hitLimit(app: FastifyInstance, key: string, limit: number, windowSeconds: number) {
  const current = await app.redis.incr(key);
  if (current === 1) await app.redis.expire(key, windowSeconds);
  return current > limit;
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

async function sendVerificationEmail(to: string, displayName: string, verifyUrl: string) {
  if (!smtpConfigured()) {
    throw new Error("SMTP_NOT_CONFIGURED");
  }

  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  const auth = process.env.SMTP_USER && process.env.SMTP_PASS
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth,
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: "Activate your ModelWiki account",
    text: [
      `Hi ${displayName},`,
      "",
      "Please activate your ModelWiki account by opening this link:",
      verifyUrl,
      "",
      "This link expires in 24 hours. If you did not create this account, you can ignore this email.",
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222">
        <h2>Activate your ModelWiki account</h2>
        <p>Hi ${displayName.replace(/[<>&"]/g, "")},</p>
        <p>Please confirm your email address before logging in.</p>
        <p><a href="${verifyUrl}" style="display:inline-block;background:#e94560;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Activate account</a></p>
        <p style="color:#666;font-size:13px">This link expires in 24 hours. If the button does not work, copy this URL:<br>${verifyUrl}</p>
      </div>
    `,
  });
}

export async function authRoutes(app: FastifyInstance) {
  const prisma = app.prisma as any;

  app.post("/register", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req: any, reply: any) => {
    if (process.env.ENABLE_PUBLIC_REGISTRATION === "false") {
      return reply.status(403).send({ success: false, error: { code: "REGISTRATION_DISABLED", message: "Public registration is disabled" } });
    }

    const { username, password, website } = registerSchema.parse(req.body);
    if (website) {
      return reply.status(400).send({ success: false, error: { code: "INVALID_REGISTRATION", message: "注册请求无效" } });
    }

    const ip = clientIp(req);
    const limitKey = `rate-limit:register:${ip}`;
    if (await hitLimit(app, limitKey, 5, 3600)) {
      return reply.status(429).send({ success: false, error: { code: "REGISTER_RATE_LIMITED", message: "注册请求过于频繁，请稍后再试" } });
    }

    const existing = await prisma.user.findFirst({ where: { displayName: username } });
    if (existing) {
      return reply.status(409).send({ success: false, error: { code: "USERNAME_EXISTS", message: "Username already registered" } });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        passwordHash,
        displayName: username,
        isActive: true,
        emailVerifiedAt: new Date(),
      },
      select: { id: true, displayName: true, role: true, isActive: true, createdAt: true },
    });

    return reply.status(201).send({
      success: true,
      data: { user, requiresEmailVerification: false },
      message: "注册成功，您可以直接登录",
    });
  });

  app.get("/verify-email", async (req: any, reply: any) => {
    const { token } = verifyEmailSchema.parse(req.query || {});
    const user = await prisma.user.findFirst({
      where: {
        emailVerifyTokenHash: tokenHash(token),
        emailVerifyExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!user) {
      return reply
        .type("text/html; charset=utf-8")
        .status(400)
        .send("<h1>Activation link is invalid or expired.</h1><p>Please register again to receive a new activation email.</p>");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isActive: true,
        emailVerifiedAt: new Date(),
        emailVerifyTokenHash: null,
        emailVerifyExpiresAt: null,
      },
    });

    return reply
      .type("text/html; charset=utf-8")
      .send('<h1>Account activated.</h1><p>You can now <a href="/account/">log in to ModelWiki</a>.</p>');
  });

  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req: any, reply: any) => {
    const { username, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findFirst({ where: { displayName: username } });

    if (!user) {
      return reply.status(401).send({ success: false, error: { code: "INVALID_CREDENTIALS", message: "用户名或密码错误" } });
    }
    if (!user.isActive) {
      return reply.status(403).send({ success: false, error: { code: "ACCOUNT_DISABLED", message: "账号已被禁用" } });
    }
    if (!user.passwordHash) {
      return reply.status(401).send({ success: false, error: { code: "NO_PASSWORD", message: "该账号未设置密码，请使用第三方登录" } });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ success: false, error: { code: "INVALID_CREDENTIALS", message: "用户名或密码错误" } });
    }

    const jwtToken = app.jwt.sign({ userId: user.id.toString(), role: user.role });
    return { success: true, data: { user: { id: user.id, displayName: user.displayName, role: user.role }, token: jwtToken } };
  });

  app.put("/password", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req: any, reply: any) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
    const authToken = auth.slice(7);
    let payload;
    try {
      payload = app.jwt.verify<{ userId: string | number; role: string }>(authToken);
    } catch {
      return reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    }

    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: BigInt(payload.userId) } });
    if (!user || !user.isActive) return reply.status(401).send({ success: false, error: { code: "USER_NOT_FOUND" } });
    if (!user.passwordHash) return reply.status(400).send({ success: false, error: { code: "NO_PASSWORD", message: "该账号未设置密码" } });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return reply.status(400).send({ success: false, error: { code: "WRONG_PASSWORD", message: "当前密码错误" } });

    const newHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
    return { success: true, data: { message: "密码修改成功" } };
  });

  app.get("/me", async (req: any, reply: any) => {
    try {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });

      const authToken = auth.slice(7);
      const payload = app.jwt.verify<{ userId: string | number; role: string }>(authToken);

      const user = await prisma.user.findUnique({
        where: { id: BigInt(payload.userId) },
        select: { id: true, email: true, displayName: true, avatarUrl: true, role: true, isActive: true, emailVerifiedAt: true, createdAt: true },
      });

      if (!user || !user.isActive) return reply.status(401).send({ success: false, error: { code: "USER_NOT_FOUND" } });

      return { success: true, data: user };
    } catch {
      return reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    }
  });
}
