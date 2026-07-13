# Auth Account Contract (FROZEN)

> **Status: FROZEN** — This contract is the authoritative specification for the account system.
> Agents A and B MUST implement exactly what is specified here. Any deviation requires explicit human approval.
> Created by Agent 0 on 2026-07-13 as part of repository reconciliation.

## 1. Overview

ModelWiki has TWO completely separate account systems:

| System | Model | Login | Used by |
|--------|-------|-------|---------|
| Frontend User | `User` | email + password | Public website users |
| Guanli AdminAccount | `AdminAccount` | username + password | `guanli` management backend |

These two systems share NOTHING except the database instance. They have different models, routes, JWT audiences, cookies, middleware, and audit logs.

---

## 2. Frontend User

### 2.1 Registration

**Input:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass!123",
  "displayName": "User Name"
}
```

**Rules:**
- `email` — required, must be valid email format
- `password` — required, must meet strength rules (min 8 chars, 1 upper, 1 lower, 1 special)
- `displayName` — required, 1-40 chars, trimmed
- Honeypot field `website` must be empty (anti-bot)
- Rate limited: 5 registrations per IP per hour

**Processing:**
1. Trim email
2. Normalize email (see §2.5)
3. Check normalizedEmail uniqueness via DB unique constraint (NOT application-layer query only)
4. Hash password with bcrypt (cost factor 12)
5. Create User record with `emailVerifiedAt: null`
6. Generate email verification token (see §2.4)
7. Send verification email via SMTP
8. Return 201 with user data (no token until email verified, OR allow login but mark unverified — see §2.6)

**Error responses:**
- 409: email already registered (same message for duplicate email to prevent enumeration)
- 429: rate limited
- 400: validation error

### 2.2 Login

**Input:**
```json
{
  "email": "user@example.com",
  "password": "SecurePass!123"
}
```

**Rules:**
- `email` — required
- `password` — required
- Rate limited: 10 attempts per minute per IP
- Login accepts email ONLY (no username login)

**Processing:**
1. Normalize email
2. Query User by normalizedEmail
3. If not found → 401 INVALID_CREDENTIALS (same message as wrong password)
4. If found but `isActive: false` → 403 ACCOUNT_DISABLED
5. If found but `passwordHash: null` → 401 NO_PASSWORD (third-party auth only)
6. Verify bcrypt password
7. If invalid → 401 INVALID_CREDENTIALS
8. Issue JWT with `{ userId, aud: "modelwiki-user" }`
9. Return token + user data

**JWT payload:**
```json
{
  "userId": "123",
  "sessionVersion": 0,
  "aud": "modelwiki-user",
  "iat": 1234567890,
  "exp": 1234567890
}
```

**JWT must NOT include `role`** — role is re-queried from DB on every privileged request.

### 2.3 Password Management

**Change password (authenticated):**
- Input: `currentPassword` + `newPassword`
- Verify current password
- Hash new password
- Update `passwordHash`
- Increment `sessionVersion` (invalidates old tokens)

**Forgot password (unauthenticated):**
- Input: `email`
- Always return 200 (anti-enumeration: same response whether email exists or not)
- If email exists: generate reset token, send email
- Reset token: 32 random bytes → base64url
- Store `SHA-256(resetToken)` in DB (NOT the raw token)
- Token expires in 1 hour
- Single use: cleared after successful reset

**Reset password:**
- Input: `token` + `newPassword`
- Hash token → look up by `passwordResetTokenHash`
- Check expiry
- If valid: update passwordHash, clear reset token, invalidate sessions
- If invalid/expired: 400 (do not reveal whether token existed)

### 2.4 Email Verification

**Token generation:**
- 32 random bytes → base64url
- Store `SHA-256(token)` in `emailVerifyTokenHash`
- Set `emailVerifyExpiresAt` = now + 24 hours

**Verification flow:**
- GET `/auth/verify-email?token=...`
- Hash token → look up user
- If found and not expired:
  - Set `emailVerifiedAt = now`
  - Clear `emailVerifyTokenHash` and `emailVerifyExpiresAt`
  - Return success HTML
- If not found or expired:
  - Return error HTML (do not reveal whether token existed)

**SMTP not configured:**
- Registration/verification endpoints must return 503 SMTP_NOT_CONFIGURED
- Must NOT return fake success (200/201 with "email sent" message)
- The error message must clearly state SMTP is not configured
- Application must NOT pretend the email was sent
- See §2.6 for full policy

### 2.5 Email Normalization

```
normalizeEmail(raw):
  1. trim whitespace
  2. split at last "@"
  3. local part: preserve EXACTLY as entered (case-sensitive, dots preserved, +tags preserved)
  4. domain part: lowercase
  5. IDN domains: normalize via IDNA2008 (e.g. "münchen.de" → "xn--mnchen-3ya.de")
  6. basic format validation (must have exactly one "@", non-empty local + domain)
  7. Store trimmed original as `email`, normalized as `normalizedEmail`
```

**Normalization rules (MANDATORY — do NOT do provider-specific rewriting):**
- ✅ trim whitespace
- ✅ domain lowercase
- ✅ IDN domain standardization (Punycode)
- ✅ basic format validation
- ❌ NOT Gmail dot-removal (DO NOT remove dots from gmail.com local parts)
- ❌ NOT `+tag` removal (DO NOT strip plus-addressing tags)
- ❌ NOT any provider-specific local part rewriting
- ❌ NOT local part case folding

- `email` — the original (trimmed) email as entered by user
- `normalizedEmail` — the normalized form used for uniqueness checking
- Both are `@unique` in the database
- Uniqueness is enforced by DB constraint (CREATE UNIQUE INDEX), not just application-layer query
- Two emails that differ only in `+tag` or local-part dots are DIFFERENT accounts (per user's explicit decision)

### 2.6 Email Verification Policy

**Production behavior check (MUST be done by Agent A):**
Agent A must inspect the current production deployment to determine:
1. Whether unverified accounts can login
2. Whether unverified accounts can favorite, comment, edit

**If production behavior CANNOT be verified, use this safest transition strategy:**
- Registration succeeds → account created in `emailVerifiedAt: null` state
- User can request to resend verification email
- Unverified users CANNOT perform write operations (favorites, comments, edits)
- Unverified users CAN login to view their profile and resend verification
- Application must NOT falsely report that a verification email was sent

**SMTP not configured:**
- Registration/verification endpoints must return 503 SMTP_NOT_CONFIGURED
- Must NOT return fake success (200/201 with "email sent" message)
- The error message must clearly state SMTP is not configured
- This allows operators to diagnose missing email config immediately

**Verified vs unverified capabilities:**

| Action | Unverified user | Verified user |
|--------|-----------------|---------------|
| Login | ✅ YES (to manage account) | ✅ YES |
| View profile | ✅ YES | ✅ YES |
| Resend verification | ✅ YES | N/A |
| Favorite/like | ❌ NO (403 EMAIL_NOT_VERIFIED) | ✅ YES |
| Comment | ❌ NO (403 EMAIL_NOT_VERIFIED) | ✅ YES |
| Edit content | ❌ NO (403 EMAIL_NOT_VERIFIED) | ✅ YES |
| Change password | ✅ YES (account security) | ✅ YES |
| Delete account | ✅ YES | ✅ YES |

### 2.7 User Model (Final)

```prisma
model User {
  id                     BigInt   @id @default(autoincrement())
  email                  String   @unique
  normalizedEmail        String   @unique @map("normalized_email")
  emailVerifiedAt        DateTime? @map("email_verified_at")
  emailVerifyTokenHash   String?  @map("email_verify_token_hash")
  emailVerifyExpiresAt   DateTime? @map("email_verify_expires_at")
  passwordResetTokenHash String?  @map("password_reset_token_hash")
  passwordResetExpiresAt DateTime? @map("password_reset_expires_at")
  passwordHash           String   @map("password_hash")
  sessionVersion         Int      @default(0) @map("session_version")
  displayName            String   @map("display_name")
  avatarUrl              String?  @map("avatar_url")
  googleSub              String?  @unique @map("google_sub")
  wechatOpenid           String?  @unique @map("wechat_openid")
  role                   String   @default("user")  // "user" | "editor" ONLY
  isActive               Boolean  @default(true) @map("is_active")
  createdAt              DateTime @default(now()) @map("created_at")
  updatedAt              DateTime @updatedAt @map("updated_at")

  favorites      Favorite[]
  favoriteGroups FavoriteGroup[]
  likes          FigureLike[]
  comments       FigureComment[]
  reviewItems    ReviewItem[]
  reviewDecisions ReviewDecision[]

  @@map("users")
}
```

**Key constraints:**
- `email` is `String` (NOT nullable) — required for all users
- `normalizedEmail` is `String` (NOT nullable) — required, unique
- `passwordHash` is `String` (NOT nullable) — required (no passwordless accounts except third-party)
- `role` is restricted to `"user"` or `"editor"` — NO admin roles here

### 2.8 Session Invalidation

When password is changed or reset:
- Increment `sessionVersion` on User model
- JWT includes `sessionVersion`; if it doesn't match DB, token is rejected
- This invalidates ALL old tokens immediately (no blacklist needed)

When account is disabled (`isActive = false`):
- Middleware re-queries DB and rejects the token
- Old tokens become invalid immediately

**JWT payload MUST include `sessionVersion`:**
```json
{
  "userId": "123",
  "sessionVersion": 0,
  "aud": "modelwiki-user",
  "iat": 1234567890,
  "exp": 1234567890
}
```

---

## 3. Guanli AdminAccount

### 3.1 Login

**Input:**
```json
{
  "username": "admin",
  "password": "AdminPass!456"
}
```

**Endpoint:** `POST /admin/auth/login` (NOT `/auth/login`)

**Rules:**
- `username` — required
- `password` — required
- Rate limited: 5 attempts per minute per IP (separate namespace from User login)
- Does NOT accept email

**Processing:**
1. Normalize username (trim + lowercase)
2. Query AdminAccount by normalizedUsername
3. If not found → 401 INVALID_CREDENTIALS
4. If found but `isActive: false` → 403 ACCOUNT_DISABLED
5. Verify bcrypt password
6. If invalid → 401 INVALID_CREDENTIALS
7. Update `lastLoginAt`
8. Issue JWT with `{ adminId, role, sessionVersion, aud: "modelwiki-admin" }`
9. Set admin-specific cookie
10. Write AdminAuditLog entry

**JWT payload:**
```json
{
  "adminId": "1",
  "role": "admin",
  "sessionVersion": 0,
  "aud": "modelwiki-admin",
  "iat": 1234567890,
  "exp": 1234567890
}
```

### 3.2 Logout

**Endpoint:** `POST /admin/auth/logout`
- Clears admin cookie
- Does NOT invalidate JWT (stateless) — but can add to blacklist if needed

### 3.3 Admin Middleware

Every admin route must use `adminGuard` middleware that:
1. Extracts JWT from admin cookie OR Authorization header
2. Verifies JWT signature AND `aud === "modelwiki-admin"`
3. Rejects User JWTs (`aud === "modelwiki-user"`) with 403
4. Queries AdminAccount by `adminId` from JWT
5. Checks `isActive === true`
6. Checks `role` is appropriate for the endpoint
7. Checks `sessionVersion` matches JWT's `sessionVersion`
8. If any check fails → 401/403

**Re-query on every sensitive request:** The middleware does NOT trust the JWT's role/isActive claims — it re-queries the DB every time.

### 3.4 Password Management

**Change password:**
- Input: `currentPassword` + `newPassword`
- Verify current
- Hash new
- Update `passwordHash` + `passwordChangedAt`
- Increment `sessionVersion` → invalidates all old tokens

**Admin disabled:**
- `isActive = false` → all existing tokens immediately invalid (middleware re-queries DB)

### 3.5 AdminAccount Initialization

**CLI command:** `npm run admin:create`
- Prompts for username + password interactively (or reads from env)
- Does NOT print password
- Does NOT overwrite existing admin
- Creates AdminAuditLog entry

**No default password in source code.** No hardcoded admin credentials.

### 3.6 AdminAccount Model (Final)

```prisma
model AdminAccount {
  id                BigInt   @id @default(autoincrement())
  username          String   @unique
  normalizedUsername String   @unique @map("normalized_username")
  passwordHash      String   @map("password_hash")
  displayName       String   @map("display_name")
  role              String   // "admin" | "reviewer" | "operator"
  isActive          Boolean  @default(true) @map("is_active")
  sessionVersion    Int      @default(0) @map("session_version")
  lastLoginAt       DateTime? @map("last_login_at")
  passwordChangedAt DateTime  @default(now()) @map("password_changed_at")
  createdAt         DateTime @default(now()) @map("created_at")
  updatedAt         DateTime @updatedAt @map("updated_at")

  auditLogs AdminAuditLog[]

  @@map("admin_accounts")
}

model AdminAuditLog {
  id           BigInt   @id @default(autoincrement())
  actorAdminId BigInt   @map("actor_admin_id")
  action       String   // "login" | "logout" | "create_admin" | "disable_admin" | "change_password" | ...
  targetType   String   @map("target_type")  // "admin" | "review" | "figure" | ...
  targetId     String?  @map("target_id")
  requestId    String?  @map("request_id")
  ip           String?
  userAgent    String?  @map("user_agent")
  createdAt    DateTime @default(now()) @map("created_at")

  admin AdminAccount @relation(fields: [actorAdminId], references: [id])

  @@index([actorAdminId, createdAt])
  @@map("admin_audit_logs")
}
```

### 3.7 Role Permissions

| Role | Can login to guanli | Review actions | Admin management | Crawler ops |
|------|---------------------|----------------|-------------------|-------------|
| `admin` | YES | ALL | YES | YES |
| `reviewer` | YES | review only | NO | NO |
| `operator` | YES | NO | NO | crawler ops only |

---

## 4. Prohibitions (Compatibility Hacks)

The following are **FORBIDDEN**:

1. ❌ Using `email` as `username` for AdminAccount
2. ❌ Using `displayName` for login in either system
3. ❌ Allowing frontend User to login to guanli (even if `role === "admin"`)
4. ❌ Deleting `User.email` to satisfy guanli's no-email requirement
5. ❌ Using the same JWT for frontend and backend
6. ❌ Using `User.role === "admin"` as guanli credential
7. ❌ Using a single User table to mix both account types
8. ❌ Using `prisma as any` to bypass schema type safety
9. ❌ Returning fake success when SMTP is not configured
10. ❌ Storing plaintext reset/verification tokens in DB (must store SHA-256 hash)
11. ❌ Reusing reset/verification tokens (must be single-use)
12. ❌ Hardcoding default admin passwords in source code

---

## 5. Cookie / Storage Separation

| Property | Frontend User | Guanli Admin |
|----------|---------------|-------------|
| Cookie name | `mw_user_token` | `mw_admin_token` |
| JWT audience | `modelwiki-user` | `modelwiki-admin` |
| Rate-limit key prefix | `rate-limit:user:` | `rate-limit:admin:` |
| Route prefix | `/auth/*` | `/admin/auth/*` |

---

## 6. Audit Logging

| Event | Frontend User | Guanli Admin |
|-------|---------------|-------------|
| Login | Redis rate-limit only | AdminAuditLog (required) |
| Logout | No | AdminAuditLog (required) |
| Password change | Redis rate-limit only | AdminAuditLog (required) |
| Account disabled | No | AdminAuditLog (required) |
| Admin created | N/A | AdminAuditLog (required) |
| Review action | ReviewDecision (in DB) | AdminAuditLog + ReviewDecision |

---

## 7. Migration Requirements

### Migration 1: User email restoration (Agent Schema)
```sql
-- Add email columns back (idempotent)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "normalized_email" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verify_token_hash" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verify_expires_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_token_hash" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_reset_expires_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_version" INTEGER NOT NULL DEFAULT 0;

-- Backfill normalized_email from email where possible
-- Users without email must be handled manually (NOT auto-filled with fake emails)

-- Add unique constraints (after data cleanup)
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "users_normalized_email_key" ON "users" ("normalized_email");

-- Make email NOT NULL (after all users have email — may require data migration first)
-- This may need to be a separate migration after data cleanup
```

### Migration 2: AdminAccount creation (Agent Schema)
```sql
CREATE TABLE IF NOT EXISTS "admin_accounts" (
  "id" BIGSERIAL PRIMARY KEY,
  "username" TEXT NOT NULL,
  "normalized_username" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "session_version" INTEGER NOT NULL DEFAULT 0,
  "last_login_at" TIMESTAMP(3),
  "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "admin_accounts_username_key" ON "admin_accounts" ("username");
CREATE UNIQUE INDEX IF NOT EXISTS "admin_accounts_normalized_username_key" ON "admin_accounts" ("normalized_username");

CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
  "id" BIGSERIAL PRIMARY KEY,
  "actor_admin_id" BIGINT NOT NULL,
  "action" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT,
  "request_id" TEXT,
  "ip" TEXT,
  "user_agent" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_audit_logs_actor_admin_id_fkey"
    FOREIGN KEY ("actor_admin_id") REFERENCES "admin_accounts"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "admin_audit_logs_actor_admin_id_created_at_idx"
  ON "admin_audit_logs" ("actor_admin_id", "created_at");
```

---

## 8. Test Requirements

### Agent User Auth tests (frontend User — Wave 2):
- register (success)
- register duplicate email (409)
- email normalization (domain case-insensitive, local part preserved)
- email normalization does NOT remove Gmail dots
- email normalization does NOT remove +tag
- login (success)
- login wrong password (401)
- login non-existent email (401, same message)
- unverified email policy (per §2.6 — unverified can login but not write)
- disabled account login (403)
- verify email token (success)
- verify expired token (400)
- verify replayed token (400)
- resend verification (success)
- forgot password (always 200)
- reset password (success)
- reset with old password fails after reset
- password change increments sessionVersion (old token invalid)
- concurrent duplicate registration (only one succeeds)
- SMTP not configured returns 503 (not fake success)
- SQL/Unicode edge inputs

### Agent Admin Auth tests (guanli AdminAccount — Wave 2):
- username login (success)
- email login rejected (400 — AdminAccount does not use email)
- wrong password (401)
- inactive admin (403)
- sessionVersion invalidation after password change (401 on retry)
- duplicate username (409)
- ordinary User JWT rejected by admin middleware (403)
- admin JWT rejected by user middleware (403)
- admin audience enforcement (aud=modelwiki-admin)
- role enforcement (reviewer cannot access admin management)
- login rate limit (429, separate namespace from User)
- audit log written on login/logout/password change
- create-admin CLI (no default password, no overwrite)
- disabled admin token immediately invalid
