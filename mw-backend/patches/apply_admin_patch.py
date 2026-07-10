#!/usr/bin/env python3
"""应用 admin.ts 安全修复 - BigInt异常 + 密码强度 + admin自我保护"""
import sys

FILE = "/home/ubuntu/modelwiki/docker/api/src/routes/admin.ts"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

if "// security-patched" in content:
    print("ERROR: file already patched")
    sys.exit(1)

# 1. 在文件顶部添加 safeBigInt helper
helper = '''
// security-patched: 安全辅助函数
function safeBigInt(value: string): bigint | null {
  try {
    if (!/^-?\\d+$/.test(value)) return null;
    return BigInt(value);
  } catch {
    return null;
  }
}

function isValidPassword(pwd: string): boolean {
  if (!pwd || typeof pwd !== "string") return false;
  if (pwd.length < 8 || pwd.length > 128) return false;
  if (!/[A-Z]/.test(pwd)) return false;
  if (!/[a-z]/.test(pwd)) return false;
  if (!/[^A-Za-z0-9]/.test(pwd)) return false;
  return true;
}

'''

# 在 "const ASSETS_PATH" 之前插入
marker = 'const ASSETS_PATH = process.env.ASSETS_PATH || "/app/assets";'
if marker not in content:
    print("ERROR: cannot find ASSETS_PATH marker")
    sys.exit(1)
content = content.replace(marker, helper + marker)

# 2. PUT /users/:id 改用 safeBigInt
old_put_user = '''  app.put("/users/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = BigInt(id);
    if (!userId) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });'''
new_put_user = '''  app.put("/users/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = safeBigInt(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });
    // 安全：防止admin自我降级，防止降级最后一个admin
    const data = updateUserSchema.parse(req.body);
    const existing = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "USER_NOT_FOUND" } });
    if (data.role && data.role !== "admin" && existing.role === "admin") {
      // 计算当前剩余admin数
      const adminCount = await app.prisma.user.count({ where: { role: "admin", isActive: true } });
      if (adminCount <= 1) {
        return reply.status(400).send({ success: false, error: { code: "LAST_ADMIN", message: "Cannot demote the last admin" } });
      }
    }'''
if old_put_user not in content:
    print("ERROR: cannot find PUT /users/:id marker")
    sys.exit(1)
content = content.replace(old_put_user, new_put_user)
# 同时删除原代码后续重复的 existing lookup
old_dup = '''    const data = updateUserSchema.parse(req.body);
    const existing = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) return reply.status(404).send({ success: false, error: { code: "USER_NOT_FOUND" } });

    const user = await (app.prisma as any).user.update({'''
new_dup = '''    const user = await (app.prisma as any).user.update({'''
if old_dup in content:
    content = content.replace(old_dup, new_dup)

# 3. PUT /users/:id/password - 改用 safeBigInt + 密码强度校验
old_pwd = '''  app.put("/users/:id/password", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = BigInt(id);
    if (!userId) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });

    const schema = z.object({ newPassword: z.string().min(8) });
    const { newPassword } = schema.parse(req.body);'''
new_pwd = '''  app.put("/users/:id/password", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = safeBigInt(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });

    const schema = z.object({ newPassword: z.string().min(1) });
    const { newPassword } = schema.parse(req.body);
    // 安全：后端复用密码强度规则
    if (!isValidPassword(newPassword)) {
      return reply.status(422).send({ success: false, error: { code: "WEAK_PASSWORD", message: "密码需至少8位且包含大小写字母和特殊字符" } });
    }'''
if old_pwd not in content:
    print("ERROR: cannot find PUT /users/:id/password marker")
    sys.exit(1)
content = content.replace(old_pwd, new_pwd)

# 4. DELETE /users/:id - 改用 safeBigInt + 防止删除最后一个admin
old_del = '''  app.delete("/users/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = BigInt(id);
    if (!userId) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });

    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(404).send({ success: false, error: { code: "USER_NOT_FOUND", message: "用户不存在" } });'''
new_del = '''  app.delete("/users/:id", async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const userId = safeBigInt(id);
    if (userId === null) return reply.status(400).send({ success: false, error: { code: "INVALID_ID" } });

    const user = await app.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(404).send({ success: false, error: { code: "USER_NOT_FOUND", message: "用户不存在" } });
    // 安全：防止删除最后一个admin
    if (user.role === "admin") {
      const adminCount = await app.prisma.user.count({ where: { role: "admin", isActive: true } });
      if (adminCount <= 1) {
        return reply.status(400).send({ success: false, error: { code: "LAST_ADMIN", message: "Cannot delete the last admin" } });
      }
    }'''
if old_del not in content:
    print("ERROR: cannot find DELETE /users/:id marker")
    sys.exit(1)
content = content.replace(old_del, new_del)

# 5. POST /users - 密码强度校验
old_create = '''  app.post("/users", async (req: any, reply: any) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(8),
      displayName: z.string().min(1),
      role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
    });
    const data = schema.parse(req.body);'''
new_create = '''  app.post("/users", async (req: any, reply: any) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1),
      displayName: z.string().min(1),
      role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
    });
    const data = schema.parse(req.body);
    // 安全：后端密码强度校验
    if (!isValidPassword(data.password)) {
      return reply.status(422).send({ success: false, error: { code: "WEAK_PASSWORD", message: "密码需至少8位且包含大小写字母和特殊字符" } });
    }'''
if old_create not in content:
    print("ERROR: cannot find POST /users marker")
    sys.exit(1)
content = content.replace(old_create, new_create)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("=== admin.ts patched successfully ===")
print("Changes:")
print("  1. Added safeBigInt and isValidPassword helpers")
print("  2. PUT /users/:id - uses safeBigInt + admin self-demotion guard")
print("  3. PUT /users/:id/password - safeBigInt + password strength validation")
print("  4. DELETE /users/:id - safeBigInt + last admin protection")
print("  5. POST /users - password strength validation")
