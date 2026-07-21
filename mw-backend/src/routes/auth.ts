import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { USER_AUDIENCE } from "../plugins/user-auth/guard.js";

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
  if (password.length > PASSWORD_RULES.maxLength) issues.push(`超过 ${PASSWORD_RULES.maxLength} 个字符`);
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
      message: `密码强度不足：${issues.join("，")}`,
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
  newPassword: passwordSchema,
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
    subject: "ModelWiki 账户邮箱验证",
    text: `你好 ${displayName}，请点击此链接验证你的邮箱：${verifyUrl}`,
    html: `<p>你好 <strong>${displayName}</strong>，</p><p>请点击下方链接完成 ModelWiki 邮箱验证：</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
  });
}

export async function authRoutes(app: FastifyInstance) {
  const prisma = (app as any).prisma;

  app.post("/register", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req: any, reply: any) => {
    if (process.env.ENABLE_PUBLIC_REGISTRATION === "false") {
      return reply.status(403).send({ success: false, error: { code: "REGISTRATION_DISABLED", message: "Public registration is disabled" } });
    }

    const { username, password, website } = registerSchema.parse(req.body);
    if (website) {
      return reply.status(400).send({ success: false, error: { code: "INVALID_REGISTRATION", message: "无效的注册请求" } });
    }

    const ip = clientIp(req);
    const limitKey = `rate-limit:register:${ip}`;
    if (await hitLimit(app, limitKey, 5, 3600)) {
      return reply.status(429).send({ success: false, error: { code: "REGISTER_RATE_LIMITED", message: "注册频繁，请稍后再试" } });
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
        sessionVersion: 0,
        emailVerifiedAt: new Date(),
      },
      select: { id: true, displayName: true, role: true, isActive: true, sessionVersion: true, createdAt: true },
    });

    return reply.status(201).send({
      success: true,
      data: { user, requiresEmailVerification: false },
      message: "注册成功，您可以直接登录",
    });
  });

  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req: any, reply: any) => {
    const { username, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findFirst({ where: { displayName: username } });

    if (!user) {
      return reply.status(401).send({ success: false, error: { code: "INVALID_CREDENTIALS", message: "用户名或密码错误" } });
    }
    if (!user.isActive) {
      return reply.status(403).send({ success: false, error: { code: "ACCOUNT_DISABLED", message: "账号已被停用" } });
    }
    if (!user.passwordHash) {
      return reply.status(401).send({ success: false, error: { code: "NO_PASSWORD", message: "账号未设置密码" } });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ success: false, error: { code: "INVALID_CREDENTIALS", message: "用户名或密码错误" } });
    }

    const jwtToken = app.jwt.sign({
      userId: user.id.toString(),
      role: user.role,
      sessionVersion: user.sessionVersion ?? 0,
      aud: USER_AUDIENCE
    });

    return {
      success: true,
      data: {
        user: { id: user.id.toString(), displayName: user.displayName, role: user.role },
        token: jwtToken,
      },
    };
  });

  app.get("/me", async (req: any, reply: any) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
    }
    const token = auth.slice(7);
    let payload: any;
    try {
      payload = app.jwt.verify(token);
    } catch {
      return reply.status(401).send({ success: false, error: { code: "INVALID_TOKEN" } });
    }

    if (payload.aud && payload.aud !== USER_AUDIENCE) {
      return reply.status(403).send({ success: false, error: { code: "FORBIDDEN", message: "Token audience not allowed" } });
    }

    const user = await prisma.user.findUnique({
      where: { id: BigInt(payload.userId) },
      select: { id: true, displayName: true, role: true, isActive: true, sessionVersion: true, createdAt: true },
    });

    if (!user || !user.isActive) {
      return reply.status(401).send({ success: false, error: { code: "UNAUTHORIZED" } });
    }

    if (typeof payload.sessionVersion === "number" && user.sessionVersion !== payload.sessionVersion) {
      return reply.status(401).send({ success: false, error: { code: "SESSION_EXPIRED", message: "Session invalidated" } });
    }

    return {
      success: true,
      data: { user: { id: user.id.toString(), username: user.displayName, role: user.role, isActive: user.isActive } },
    };
  });
}
