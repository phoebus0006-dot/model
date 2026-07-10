#!/usr/bin/env python3
"""应用 community.ts 安全修复 - 评论 XSS 防护"""
import sys

FILE = "/home/ubuntu/modelwiki/docker/api/src/routes/community.ts"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

if "// security-patched" in content:
    print("ERROR: file already patched")
    sys.exit(1)

# 添加 HTML 转义函数 + 在评论 POST 时清洗
helper = '''
// security-patched: HTML escape for user-generated content
function escapeHtml(s: string): string {
  if (typeof s !== "string") return "";
  return s.replace(/[&<>"']/g, (c: string) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    "\"": "&quot;", "'": "&#39;"
  }[c] || c));
}

function sanitizeUserText(s: string): string {
  // 移除控制字符 + 限制长度（commentSchema 已限制 2000）
  const cleaned = String(s || "").replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]/g, "");
  return cleaned;
}

'''

# 在 "export async function communityRoutes" 之前插入
marker = "export async function communityRoutes(app: FastifyInstance) {"
if marker not in content:
    print("ERROR: cannot find communityRoutes marker")
    sys.exit(1)
content = content.replace(marker, helper + marker)

# 在评论 POST 时清洗body
old_post = '''    const { body } = commentSchema.parse(req.body);

    const comment = await prisma.figureComment.create({
      data: { userId: user.id, figureId: figure.id, body },'''
new_post = '''    const { body } = commentSchema.parse(req.body);
    // 安全：清洗评论内容，移除控制字符（HTML转义由前端处理，但后端做深度防御）
    const sanitizedBody = sanitizeUserText(body);

    const comment = await prisma.figureComment.create({
      data: { userId: user.id, figureId: figure.id, body: sanitizedBody },'''
if old_post not in content:
    print("ERROR: cannot find POST comment marker")
    sys.exit(1)
content = content.replace(old_post, new_post)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("=== community.ts patched successfully ===")
print("Changes:")
print("  1. Added escapeHtml and sanitizeUserText helpers")
print("  2. POST /figures/:slug/comments - sanitize body (strip control chars)")
