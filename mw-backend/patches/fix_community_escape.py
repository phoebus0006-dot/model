#!/usr/bin/env python3
"""修复 community.ts 中的字符串转义问题"""
import sys

FILE = "/home/ubuntu/modelwiki/docker/api/src/routes/community.ts"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

# 修复错误的 escapeHtml 函数（Python 字符串转义破坏了 TS 语法）
# 用 chr() 函数避免字符串嵌套问题
old_block = '''// security-patched: HTML escape for user-generated content
function escapeHtml(s: string): string {
  if (typeof s !== "string") return "";
  return s.replace(/[&<>"']/g, (c: string) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    """: "&quot;", "'": "&#39;"
  }[c] || c));
}

function sanitizeUserText(s: string): string {
  // 移除控制字符 + 限制长度（commentSchema 已限制 2000）
  const cleaned = String(s || "").replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]/g, "");
  return cleaned;
}'''

# 使用 chr() 避免引号嵌套
DQ = chr(34)  # 双引号
SQ = chr(39)  # 单引号
BS = chr(92)  # 反斜杠

new_block = f'''// security-patched: HTML escape for user-generated content
function escapeHtml(s: string): string {{
  if (typeof s !== {DQ}string{DQ}) return {DQ}{DQ};
  return s.replace(/[&<>{DQ}{SQ}]/g, (c: string) => ({{
    {DQ}&{DQ}: {DQ}&amp;{DQ}, {DQ}<{DQ}: {DQ}&lt;{DQ}, {DQ}>{DQ}: {DQ}&gt;{DQ},
    {DQ}{DQ}{DQ}: {DQ}&quot;{DQ}, {DQ}{SQ}{DQ}: {DQ}&#39;{DQ}
  }}[c] || c));
}}

function sanitizeUserText(s: string): string {{
  const cleaned = String(s || {DQ}{DQ}).replace(/[{BS}x00-{BS}x08{BS}x0B{BS}x0C{BS}x0E-{BS}x1F{BS}x7F]/g, {DQ}{DQ});
  return cleaned;
}}'''

if old_block in content:
    content = content.replace(old_block, new_block)
    print("Replaced using exact match")
else:
    # 用更宽松的匹配
    import re
    pattern = r'// security-patched: HTML escape.*?return cleaned;\n\}'
    match = re.search(pattern, content, re.DOTALL)
    if match:
        content = content[:match.start()] + new_block + content[match.end():]
        print("Replaced using regex match")
    else:
        print("ERROR: cannot find block to replace")
        sys.exit(1)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("=== community.ts escape fixed ===")
