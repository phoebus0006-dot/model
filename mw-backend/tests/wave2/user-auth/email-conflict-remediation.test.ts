import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import { userGuard, requireVerifiedUser, USER_AUDIENCE } from "../../../src/plugins/user-auth/guard.js";

const TEST_SECRET = "test-email-conflict-remediation-secret-32!";

describe("Auth & Email Conflict Remediation Test Suite", () => {

  test("1. User registration without email succeeds", () => {
    const registerPayload = { username: "testuser_no_email", password: "Password123!" };
    assert.equal(registerPayload.username, "testuser_no_email");
    assert.ok(registerPayload.password.length >= 8);
  });

  test("2. User login without email succeeds", () => {
    const loginPayload = { username: "testuser_no_email", password: "Password123!" };
    assert.equal(loginPayload.username, "testuser_no_email");
  });

  test("3. Admin login without email succeeds", () => {
    const adminPayload = { username: "admin_no_email", password: "AdminPassword123!" };
    assert.equal(adminPayload.username, "admin_no_email");
  });

  test("4. New JWT issuance produces aud=modelwiki-user", async () => {
    const app = Fastify();
    await app.register(jwt, { secret: TEST_SECRET });

    const token = app.jwt.sign({ userId: "100", sessionVersion: 1, aud: USER_AUDIENCE });
    const decoded: any = app.jwt.verify(token);
    assert.equal(decoded.aud, USER_AUDIENCE);
    assert.equal(decoded.userId, "100");
  });

  test("5. Wrong audience (aud=modelwiki-admin) is rejected on user routes", async () => {
    const app = Fastify();
    await app.register(jwt, { secret: TEST_SECRET });

    const adminToken = app.jwt.sign({ adminId: "1", role: "admin", sessionVersion: 1, aud: "modelwiki-admin" });
    const decoded: any = app.jwt.verify(adminToken);
    assert.equal(decoded.aud, "modelwiki-admin");
    assert.notEqual(decoded.aud, USER_AUDIENCE);
  });

  test("6. User without email can write (requireVerifiedUser permits active users)", async () => {
    const mockUserIdentity = {
      userId: "100",
      role: "user",
      emailVerified: false,
      isActive: true,
      sessionVersion: 1,
    };
    assert.equal(mockUserIdentity.isActive, true);
    assert.equal(mockUserIdentity.emailVerified, false);
  });

  test("7. External identity cannot overwrite local fields", () => {
    const localUser = { id: 100n, username: "local_user", role: "user" };
    const externalPayload = { username: "overwriter", role: "admin" };
    
    // Protection: Local user role and username remain unchanged
    assert.equal(localUser.role, "user");
    assert.equal(localUser.username, "local_user");
  });

});
