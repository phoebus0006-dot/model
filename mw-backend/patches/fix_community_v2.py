#!/usr/bin/env python3
"""彻底重写 community.ts 的 helper 函数 - 用最简单的字符串避免转义问题"""
import sys

FILE = "/home/ubuntu/modelwiki/docker/api/src/routes/community.ts"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

# 找到旧的 escapeHtml + sanitizeUserText 块，用更简单的实现替换
# 使用 split 方式，避免复杂的正则
start_marker = "// security-patched: HTML escape"
end_marker = "export async function communityRoutes"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

if start_idx == -1 or end_idx == -1:
    print("ERROR: cannot find markers")
    sys.exit(1)

# 新的 helper 块 - 使用 ASCII 编码避免引号嵌套
new_helpers = '''// security-patched: HTML escape for user-generated content
// 使用 String.fromCharCode 避免引号转义问题
function escapeHtml(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\\\/g, "&#39;")
    .replace(/"/g, "&quot;");
}

function sanitizeUserText(s) {
  // 移除控制字符，保留可见字符
  var cleaned = String(s || "");
  // 移除 NUL 到 US (除 HT/LF/CR)
  cleaned = cleaned.replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]/g, "");
  return cleaned;
}

'''

# 替换整个 helper 块
content = content[:start_idx] + new_helpers + content[end_idx:]

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("=== community.ts helpers rewritten ===")
