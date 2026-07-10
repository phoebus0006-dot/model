#!/bin/bash
# 主部署脚本 - 应用所有后端安全修复
set -e

echo "===== Step 1: 上传 patch 脚本到服务器 ====="
scp -i C:\\Users\\wspho\\.ssh\\[SSH_KEY] -o StrictHostKeyChecking=no \
  "d:\\model wiki\\mw-backend\\patches\\setup_patches.sh" \
  "d:\\model wiki\\mw-backend\\patches\\apply_images_patch.py" \
  "d:\\model wiki\\mw-backend\\patches\\apply_auth_patch.py" \
  "d:\\model wiki\\mw-backend\\patches\\apply_admin_patch.py" \
  "d:\\model wiki\\mw-backend\\patches\\apply_community_patch.py" \
  ubuntu@[ORACLE_IP]:/tmp/

echo ""
echo "===== Step 2: 准备 SSRF guard 代码片段 ====="
ssh -i C:\\Users\\wspho\\.ssh\\[SSH_KEY] -o StrictHostKeyChecking=no ubuntu@[ORACLE_IP] \
  "bash /tmp/setup_patches.sh"

echo ""
echo "===== Step 3: 应用 images.ts 修复 ====="
ssh -i C:\\Users\\wspho\\.ssh\\[SSH_KEY] -o StrictHostKeyChecking=no ubuntu@[ORACLE_IP] \
  "sudo python3 /tmp/apply_images_patch.py"

echo ""
echo "===== Step 4: 应用 auth.ts 修复 ====="
ssh -i C:\\Users\\wspho\\.ssh\\[SSH_KEY] -o StrictHostKeyChecking=no ubuntu@[ORACLE_IP] \
  "sudo python3 /tmp/apply_auth_patch.py"

echo ""
echo "===== Step 5: 应用 admin.ts 修复 ====="
ssh -i C:\\Users\\wspho\\.ssh\\[SSH_KEY] -o StrictHostKeyChecking=no ubuntu@[ORACLE_IP] \
  "sudo python3 /tmp/apply_admin_patch.py"

echo ""
echo "===== Step 6: 应用 community.ts 修复 ====="
ssh -i C:\\Users\\wspho\\.ssh\\[SSH_KEY] -o StrictHostKeyChecking=no ubuntu@[ORACLE_IP] \
  "sudo python3 /tmp/apply_community_patch.py"

echo ""
echo "===== Step 7: TypeScript 语法检查 ====="
ssh -i C:\\Users\\wspho\\.ssh\\[SSH_KEY] -o StrictHostKeyChecking=no ubuntu@[ORACLE_IP] \
  "cd /home/ubuntu/modelwiki/docker/api && docker run --rm -v \$(pwd):/app -w /app node:20-slim npx tsc --noEmit 2>&1 | head -50"

echo ""
echo "===== Step 8: 重新构建 mw-api 容器 ====="
ssh -i C:\\Users\\wspho\\.ssh\\[SSH_KEY] -o StrictHostKeyChecking=no ubuntu@[ORACLE_IP] \
  "cd /home/ubuntu/modelwiki/docker && docker compose build api 2>&1 | tail -30"

echo ""
echo "===== Step 9: 重启 mw-api 容器 ====="
ssh -i C:\\Users\\wspho\\.ssh\\[SSH_KEY] -o StrictHostKeyChecking=no ubuntu@[ORACLE_IP] \
  "cd /home/ubuntu/modelwiki/docker && docker compose up -d api 2>&1"

echo ""
echo "===== Step 10: 验证服务启动 ====="
sleep 3
ssh -i C:\\Users\\wspho\\.ssh\\[SSH_KEY] -o StrictHostKeyChecking=no ubuntu@[ORACLE_IP] \
  "docker logs mw-api --tail 20 2>&1; curl -s http://localhost:3001/health"
