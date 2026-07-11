import { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { updateUserSchema, createUserSchema, passwordUpdateSchema, safeBigInt, isValidPassword } from "./schemas.js";

export async function adminUserRoutes(app: FastifyInstance) {
  app.get("/users", async () => {
    const users = await app.prisma.user.findMany({
      select: { id: true, email: true, displayName: true, role: true, isActive: true, emailVerifiedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    return { success: true, data: users };
  });

  app.put("/users/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = safeBigInt(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });
    const data = updateUserSchema.parse(req.body);
    const existing = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "USER_NOT_FOUND" } });
    if (data.role && data.role !== "admin" && existing.role === "admin") {
      const adminCount = await app.prisma.user.count({ where: { role: "admin", isActive: true } });
      if (adminCount <= 1) {
        return reply.status(400).send({ success: false, error: { code: "LAST_ADMIN", message: "Cannot demote the last admin" } });
      }
    }
    const user = await app.prisma.user.update({
      where: { id: userId }, data,
      select: { id: true, email: true, displayName: true, role: true, isActive: true, emailVerifiedAt: true, createdAt: true },
    });
    return { success: true, data: user };
  });

  app.put("/users/:id/password", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = safeBigInt(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });
    const { newPassword } = passwordUpdateSchema.parse(req.body);
    if (!isValidPassword(newPassword)) {
      return reply.status(422).send({ success: false, error: { code: "WEAK_PASSWORD", message: "密码需至少8位且包含大小写字母和特殊字符" } });
    }
    const existing = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "USER_NOT_FOUND" } });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await app.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return { success: true, data: { message: "密码已重置" } };
  });

  app.post("/users", async (req: any, reply: any) => {
    const data = createUserSchema.parse(req.body);
    if (!isValidPassword(data.password)) {
      return reply.status(422).send({ success: false, error: { code: "WEAK_PASSWORD", message: "密码需至少8位且包含大小写字母和特殊字符" } });
    }
    const existing = await app.prisma.user.findUnique({ where: { email: data.email } });
    if (existing) return reply.status(409).send({ success: false, error: { code: "EMAIL_EXISTS", message: "邮箱已被使用" } });
    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await app.prisma.user.create({
      data: { email: data.email, passwordHash, displayName: data.displayName, role: data.role, emailVerifiedAt: new Date() },
      select: { id: true, email: true, displayName: true, role: true, isActive: true, emailVerifiedAt: true, createdAt: true },
    });
    return reply.status(201).send({ success: true, data: user });
  });

  app.delete("/users/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = safeBigInt(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });
    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(404).send({ success: false, error: { code: "USER_NOT_FOUND", message: "用户不存在" } });
    if (user.role === "admin") {
      const adminCount = await app.prisma.user.count({ where: { role: "admin", isActive: true } });
      if (adminCount <= 1) {
        return reply.status(400).send({ success: false, error: { code: "LAST_ADMIN", message: "Cannot delete the last admin" } });
      }
    }
    await app.prisma.$transaction([
      app.prisma.favoriteGroup.deleteMany({ where: { userId } }),
      app.prisma.favorite.deleteMany({ where: { userId } }),
      app.prisma.user.delete({ where: { id: userId } }),
    ]);
    return { success: true, data: { message: "用户已删除" } };
  });
}
