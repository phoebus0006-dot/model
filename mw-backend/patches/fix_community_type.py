#!/usr/bin/env python3
"""修复 community.ts 中 sanitizeUserText 的类型注解"""
import sys

FILE = "/home/ubuntu/modelwiki/docker/api/src/routes/community.ts"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

# 给 sanitizeUserText 加上类型注解
content = content.replace(
    "function sanitizeUserText(s) {",
    "function sanitizeUserText(s: string): string {"
)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("=== community.ts type annotation fixed ===")
