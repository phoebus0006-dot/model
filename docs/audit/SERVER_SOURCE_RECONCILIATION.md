# Server Source Reconciliation

登录服务器后填写。

## HEAD 对比

| 项目 | 本机 (local) | 服务器 (server) |
|------|-------------|-----------------|
| `git rev-parse HEAD` | `98262bb` | — |
| `git branch --show-current` | `master` | — |
| `git status --short` | 38 modified + ~100 untracked | — |
| 是否有未提交修改 | ✅ | — |
| Phase 3.5-F/G 修改是否包含 | ✅ | — |

## 差异分析

```bash
# 服务器上执行：
cd /path/to/repo
git rev-parse HEAD
git branch --show-current
git log --oneline -5
git status --short
git diff --stat HEAD | tail -5
```

## 测试源码部署方案

- [ ] 服务器已有当前源码（git pull 后包含所有修改）
- [ ] 需要从本机复制（scp/rsync）
- [ ] 使用独立测试目录（推荐）

## 复制注意

如果从本机复制到服务器：

```bash
# 在本机（local）执行：
cd /path/to/local/repo
tar --exclude='.git' --exclude='node_modules' --exclude='dist' \
    --exclude='.env' --exclude='*.log' \
    -czf /tmp/modelwiki-source.tar.gz \
    mw-backend/src mw-backend/prisma mw-backend/scripts \
    mw-backend/package.json \
    docs/audit tests crawler_common.py requirements.txt

# 传输到服务器
scp /tmp/modelwiki-source.tar.gz user@server:/tmp/

# 在服务器上解压到测试目录
mkdir -p ~/modelwiki-test
cd ~/modelwiki-test
tar xzf /tmp/modelwiki-source.tar.gz
cd mw-backend && npm install
```
