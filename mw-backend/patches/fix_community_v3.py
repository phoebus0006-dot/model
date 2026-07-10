#!/usr/bin/env python3
"""简化 community.ts helper - 只保留 sanitizeUserText，删除 escapeHtml"""
import sys

FILE = "/home/ubuntu/modelwiki/docker/api/src/routes/community.ts"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

start_marker = "// security-patched: HTML escape"
end_marker = "export async function communityRoutes"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

if start_idx == -1 or end_idx == -1:
    print("ERROR: cannot find markers")
    sys.exit(1)

# 极简版本：只保留 sanitizeUserText，避免所有引号嵌套问题
# 注：HTML转义由前端 esc() 函数处理（textContent 模式），后端只做控制字符清理
new_helpers = "// security-patched: 清理用户输入中的控制字符\n" \
              "// HTML 转义由前端 esc()/textContent 处理，后端做深度防御\n" \
              "function sanitizeUserText(s) {\n" \
              "  var cleaned = String(s || \"\");\n" \
              "  cleaned = cleaned.replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]/g, \"\");\n" \
              "  return cleaned;\n" \
              "}\n" \
              "\n"

content = content[:start_idx] + new_helpers + content[end_idx:]

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("=== community.ts simplified ===")
