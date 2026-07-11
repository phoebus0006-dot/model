# Server Environment Classification

## 分类表（登录服务器后填写）

| 项目 | 结果 | 脱敏值 |
|------|------|--------|
| hostname | — | — |
| 登录用户 | — | — |
| 当前目录 | — | — |
| 环境类型 (PRODUCTION/STAGING/TEST/UNKNOWN) | — | — |
| 是否有真实用户流量 | — | — |
| 是否允许写入测试 | — | — |
| Node 版本 | — | — |
| PostgreSQL 版本 | — | — |
| PostgreSQL 可访问 | — | — |
| Redis 版本 | — | — |
| Redis 可访问 | — | — |
| Docker 可用 | — | — |
| Docker Compose 可用 | — | — |
| PHP 版本 | — | — |
| WordPress 路径 | — | — |
| 仓库 HEAD | — | — |
| 仓库分支 | — | — |

## 判断依据

```bash
# 环境类型判断
hostname
cat /etc/hostname
cat /etc/*release 2>/dev/null | head -5
echo $NODE_ENV
echo $APP_ENV

# 用户流量
ss -lntp | grep -E ":(80|443) "
curl -s -o /dev/null -w "%{http_code}" http://localhost/ 2>/dev/null || true

# PostgreSQL
psql --version
pg_isready 2>/dev/null || true

# Redis
redis-cli --version
redis-cli ping 2>/dev/null || true

# Docker
docker --version 2>/dev/null || true
docker compose version 2>/dev/null || true
podman --version 2>/dev/null || true
```

## 安全规则

- ❌ 不输出 `.env` 文件内容
- ❌ 不输出数据库密码
- ❌ 不输出 Redis 密码
- ❌ 不输出 JWT secret
- ❌ 不输出完整连接 URL
- ✅ 允许输出脱敏信息：host, port, database name, username
