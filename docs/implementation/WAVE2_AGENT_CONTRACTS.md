# Wave 2 Agent Contracts (FROZEN)

> **Status: FROZEN** — Authoritative specifications for Wave 2 agents.
> **Supersedes** the old WAVE2_AGENT_CONTRACTS.md (which contained Agent F/G/H — those are now Wave 3).
> **Start conditions:** Agent Schema merged (prisma generate + validate + migrate deploy on disposable DB pass) + Agent QA merged (gate passes) + Agent Repository Hygiene merged.

## Wave 2 Start Conditions (ALL must be TRUE)

- [ ] account-schema-migrations merged
- [ ] qa-real-baseline merged
- [ ] repository-hygiene merged
- [ ] `prisma generate` passes
- [ ] `prisma validate` passes
- [ ] `migrate deploy` on disposable DB passes

Then Wave 2 agents (parallel, different file ownership):
- Agent User Auth (`agent/frontend-email-auth`) — `auth.ts`
- Agent Admin Auth (`agent/guanli-admin-auth`) — `admin-auth.*`
- Agent Runtime (`agent/runtime-account-isolation`) — `index.ts`

---

## Agent User Auth: 前台邮箱注册和登录

**Branch:** `agent/frontend-email-auth`
**Wave:** 2 (parallel)
**Base:** Latest main after Wave 1 merge

### File Ownership (EXCLUSIVE)
- `mw-backend/src/routes/auth.ts`
- `mw-backend/src/services/user-auth/**`
- `mw-backend/src/plugins/user-auth/**`
- email sending service
- User auth tests

### Prohibited
- Modify `schema.prisma`
- Modify AdminAccount routes
- Modify `adminGuard`
- Modify Guanli pages
- Modify Review/Crawler

### Tasks
1. Completely remove username/displayName login logic
2. Registration input: `email`, `password`, `displayName`
3. Login input: `email`, `password`
4. Use `normalizedEmail` for queries
5. FORBIDDEN `app.prisma as any`
6. All fields must exist in Prisma Schema
7. Registration relies on DB unique constraint for concurrent duplicate handling
8. Password strength: min 8 chars, uppercase, lowercase, digit or special char
9. Login failure returns unified INVALID_CREDENTIALS
10. Disabled account returns clear status but no info leak
11. JWT: `aud=modelwiki-user`, `userId` string, `sessionVersion`, NO `role` in JWT
12. Privileged requests re-query User: `isActive`, `role`, `sessionVersion`
13. Email verification: random token, DB stores SHA-256 only, 24h expiry, single use, resend support
14. Forgot password: always return 200, token hash stored, 1h expiry, single use
15. Password change/reset: `sessionVersion + 1`, old tokens invalidated
16. SMTP not configured: NO fake success, return per frozen contract (503)
17. DO NOT implement Gmail dot-removal or `+tag` deletion
18. DO NOT log raw tokens, passwords, or full credentials
19. Email-related logs must be redacted

### Required Tests
- registration
- login
- duplicate email
- concurrent duplicate registration
- domain case normalization
- local part preservation (no +tag stripping, no dot removal)
- wrong password
- disabled user
- verification success
- expired verification
- verification replay
- resend verification
- forgot password anti-enumeration
- reset password
- reset replay
- password change → sessionVersion increment → old token invalid
- session invalidation
- SQL/Unicode edge inputs
- SMTP not configured → 503

### Acceptance
- Real PostgreSQL test
- No Prisma runtime field errors
- No username login
- Frontend email complete loop

---

## Agent Admin Auth: Guanli 独立管理员认证

**Branch:** `agent/guanli-admin-auth`
**Wave:** 2 (parallel)
**Base:** Latest main after Wave 1 merge

### File Ownership (EXCLUSIVE)
- `mw-backend/src/routes/admin-auth.*`
- `mw-backend/src/plugins/admin-auth/**`
- `mw-backend/src/services/admin-auth/**`
- admin create CLI
- Admin auth tests

### Prohibited
- Modify `auth.ts`
- Modify User email auth
- Modify `schema.prisma`
- Modify Review route
- Modify `guanli_index.php`

### Tasks
1. Implement: `POST /admin/auth/login`, `POST /admin/auth/logout`, `POST /admin/auth/change-password`, `GET /admin/auth/me`
2. Accept ONLY username + password
3. DO NOT accept email
4. Username normalization: trim + lowercase
5. JWT: `aud=modelwiki-admin`, `adminId`, `sessionVersion`, short TTL
6. Use independent Cookie/storage namespace
7. adminGuard: verify audience, query AdminAccount, check isActive, check sessionVersion, re-query role
8. User JWT MUST be rejected
9. Admin JWT cannot act as User JWT
10. Change password: verify old, update hash, sessionVersion + 1, update passwordChangedAt
11. Disabled admin → old tokens immediately invalid
12. Every sensitive action writes AdminAuditLog
13. Login rate limit uses different namespace from User login
14. Create admin CLI: no default password, no password output, no overwrite existing username, interactive or env var
15. DO NOT create hardcoded admin/admin
16. DO NOT auto-convert User to AdminAccount

### Required Tests
- username login
- email login rejected
- wrong password
- inactive admin
- sessionVersion invalidation
- change password
- duplicate username
- user token rejected
- admin audience enforcement
- role enforcement
- login rate limit
- audit log
- create-admin CLI

### Acceptance
- Guanli does not require email
- Completely isolated from frontend User
- Real PostgreSQL test passes

---

## Agent Runtime: 运行时、安全和身份隔离

**Branch:** `agent/runtime-account-isolation`
**Wave:** 2 (parallel)
**Base:** Latest main after Wave 1 merge

### File Ownership (EXCLUSIVE)
- `mw-backend/src/index.ts`
- runtime plugin/config
- JWT registration and middleware mounting
- readiness and shutdown tests

### Prohibited
- Modify `auth.ts`
- Modify admin-auth routes
- Modify `schema.prisma`
- Modify `admin.ts`

### Tasks
1. Support both `userGuard` and `adminGuard` simultaneously
2. Both verify different JWT audiences
3. NO fallback to other identity
4. NO same request having both user and admin identity
5. Type definitions: `req.user` and `req.admin` separate
6. Remove old ambiguous admin判断
7. Admin routes mount adminGuard ONLY
8. User routes mount userGuard ONLY
9. BigInt API output continues as string
10. Check: `/health`, `/ready`, graceful shutdown, Prisma disconnect, Redis quit
11. Production secret missing → fail closed
12. User JWT secret and Admin JWT secret: independent secrets recommended (or same key with strict audience)
13. CORS, Cookie secure, sameSite, domain explicit per deployment env
14. DO NOT log JWT
15. Add identity isolation tests

### Acceptance
- User/Admin tokens cannot cross
- Disabled account real-time invalid
- Password change → old token invalid
- startup/shutdown passes
