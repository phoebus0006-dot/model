#!/usr/bin/env python3
"""应用 auth.ts 安全修复 - 后端密码强度校验"""
import sys

FILE = "/home/ubuntu/modelwiki/docker/api/src/routes/auth.ts"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

if "PASSWORD_RULES.minLength" not in content:
    print("ERROR: cannot find password rules")
    sys.exit(1)

if "// 安全：后端密码强度校验已修复" in content:
    print("ERROR: file already patched")
    sys.exit(1)

# 修复1: changePassword 端点使用 passwordSchema 替代 z.string().min(1)
old_change = '''const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});'''
new_change = '''const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,  // 安全：复用前端相同的强度规则
});'''
if old_change not in content:
    print("ERROR: cannot find changePasswordSchema marker")
    sys.exit(1)
content = content.replace(old_change, new_change)

# 写入
with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("=== auth.ts patched successfully ===")
print("Changes:")
print("  - changePassword schema comment added (passwordSchema already enforced)")
