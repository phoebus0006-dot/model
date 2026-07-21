// Wave 2 Runtime: barrel export for the dual-identity runtime modules.
//
// The Integrator mounts these alongside the User/Admin auth agents' exports:
//   - authRoutes       (User Auth Agent)  → prefix /api/v1/auth
//   - adminAuthRoutes  (Admin Auth Agent) → prefix /api/v1/admin/auth
//   - userGuard        (User Auth Agent)  → on user-protected routes
//   - adminGuard       (Admin Auth Agent) → on admin-protected routes
//
// This module provides the runtime infrastructure those guards depend on:
// configuration, JWT factories, identity collision enforcement, and shutdown.

export {
  loadRuntimeConfig,
  ConfigError,
  USER_JWT_AUDIENCE,
  ADMIN_JWT_AUDIENCE,
  USER_COOKIE_NAME,
  ADMIN_COOKIE_NAME,
  MIN_SECRET_LENGTH,
  LOG_REDACT_PATHS,
  type RuntimeConfig,
  type RuntimeCookieConfig,
  type RuntimeCorsConfig,
} from "./config.js";

export { buildUserJwtOptions, buildAdminJwtOptions } from "./jwt.js";

export {
  registerIdentityCollisionGuard,
  rejectDualIdentity,
  assertNoIdentityCollision,
} from "./identity.js";

export { createShutdownManager, type ShutdownManager } from "./shutdown.js";
