import { test, expect, describe, spyOn, afterAll } from "bun:test";
import invariant from "tiny-invariant";
import { createDate, TimeSpan } from "oslo";
import { generateIdFromEntropySize } from "lucia";
import { eq } from "drizzle-orm";

import { AuthService } from "~/services/auth-service";
import { sqliteTest, dbTest } from "../db";
import * as schema from "../../db/schema";
import type { AsyncResult, EmailServiceInterface } from "~/lib/types";

class MockEmailService implements EmailServiceInterface {
  sendConfirmEmail = (_: string): AsyncResult<null, "email_send_error"> => {
    return Promise.resolve({ type: "success", data: null });
  };

  sendResetPasswordEmail = (
    _email: string,
    _verificationLink: string
  ): AsyncResult<null, "email_send_error"> => {
    return Promise.resolve({ type: "success", data: null });
  };
}

const mockEmailService = new MockEmailService();
const authService = new AuthService(sqliteTest, mockEmailService);

describe("AuthService", () => {
  const randomEmail = `${generateIdFromEntropySize(10)}@test.com`;
  const randomPassword = generateIdFromEntropySize(10);

  afterAll(async () => {
    await dbTest
      .delete(schema.users)
      .where(eq(schema.users.email, randomEmail));
  });

  test("signup with valid email should create a user", async () => {
    const sendConfirmEmailSpy = spyOn(mockEmailService, "sendConfirmEmail");
    expect(sendConfirmEmailSpy).toHaveBeenCalledTimes(0);

    const signupResult = await authService.signup({
      email: randomEmail,
      password: randomPassword,
    });

    expect(sendConfirmEmailSpy).toHaveBeenCalledTimes(1);
    const lastCall = sendConfirmEmailSpy.mock.lastCall;
    invariant(lastCall);

    // First parameter is the email
    // Second parameter is the random confirmation email code
    expect(lastCall[0]).toEqual(randomEmail);

    expect(signupResult.type).toEqual("success");
    if (signupResult.type === "success") {
      expect(signupResult.data.sessionId).toBeTruthy();
    }

    const user = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(user).toBeTruthy();
    invariant(user);
  });

  test("signup with duplicated email should return error", async () => {
    const duplicatedSignupResult = await authService.signup({
      email: randomEmail,
      password: randomPassword,
    });

    expect(duplicatedSignupResult.type).toEqual("failure");
    invariant(duplicatedSignupResult.type === "failure");

    expect(duplicatedSignupResult.error).toEqual("user_exists");
  });

  test("signup should create an email verification code", async () => {
    const user = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(user).toBeTruthy();
    invariant(user);

    const emailVerificationCode =
      await dbTest.query.emailVerificationCodes.findFirst({
        where: eq(schema.emailVerificationCodes.userId, user.id),
      });

    expect(emailVerificationCode).toBeTruthy();
    invariant(emailVerificationCode);

    expect(emailVerificationCode.email).toEqual(randomEmail);
  });

  test("login with valid email and password should return session id", async () => {
    const loginResult = await authService.login({
      email: randomEmail,
      password: randomPassword,
    });

    expect(loginResult.type).toEqual("success");
    if (loginResult.type === "success") {
      expect(loginResult.data.sessionId).toBeTruthy();
    }
  });

  test("login with invalid email should return user_not_found", async () => {
    const loginResult = await authService.login({
      email: "fake",
      password: randomPassword,
    });

    expect(loginResult.type).toEqual("failure");
    invariant(loginResult.type === "failure");

    expect(loginResult.error).toEqual("user_not_found");
  });

  test("login with invalid password should return invalid_credentials", async () => {
    const loginResult = await authService.login({
      email: randomEmail,
      password: "wrong_password",
    });

    expect(loginResult.type).toEqual("failure");
    invariant(loginResult.type === "failure");

    expect(loginResult.error).toEqual("invalid_credentials");
  });

  test("sessions should expire in 30 days", async () => {
    const user = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(user).toBeTruthy();
    invariant(user);

    const session = await dbTest.query.sessions.findFirst({
      where: eq(schema.sessions.userId, user.id),
    });

    expect(session).toBeTruthy();
    invariant(session);
    expect(session.userId).toEqual(user.id);

    const twentyNineDaysLater = createDate(new TimeSpan(29, "d"));
    expect(session.expiresAt.getTime()).toBeGreaterThan(
      twentyNineDaysLater.getTime()
    );

    const thirtyOneDaysLater = createDate(new TimeSpan(31, "d"));
    expect(session.expiresAt.getTime()).toBeLessThan(
      thirtyOneDaysLater.getTime()
    );
  });

  test("should use bun password hash", async () => {
    const user = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(user).toBeTruthy();
    invariant(user);

    const isMatch = await Bun.password.verify(
      randomPassword,
      user.passwordHash
    );
    expect(isMatch).toEqual(true);
  });

  test("validate session should return a user", async () => {
    const result = await authService.login({
      email: randomEmail,
      password: randomPassword,
    });

    expect(result.type).toEqual("success");
    invariant(result.type === "success");

    const sessionId = result.data.sessionId;

    const validatedSessionResult = await authService.validateSession(sessionId);

    expect(validatedSessionResult.type).toEqual("success");
    invariant(validatedSessionResult.type === "success");

    const user = validatedSessionResult.data.user;
    expect(user.email).toEqual(randomEmail);

    expect(validatedSessionResult.data.freshSessionId).toBeFalsy();
  });

  test("validate session should return a fresh token if expires_at is less than 15 days", async () => {
    const result = await authService.login({
      email: randomEmail,
      password: randomPassword,
    });

    expect(result.type).toEqual("success");
    invariant(result.type === "success");

    const sessionId = result.data.sessionId;

    await dbTest
      .update(schema.sessions)
      .set({
        expiresAt: createDate(new TimeSpan(15, "d")),
      })
      .where(eq(schema.sessions.id, sessionId));

    const validatedSessionResult = await authService.validateSession(sessionId);
    expect(validatedSessionResult.type).toEqual("success");
    invariant(validatedSessionResult.type === "success");

    // Should return a fresh session id
    expect(validatedSessionResult.data.freshSessionId).toBeTruthy();
  });

  test("verifyEmailCode should return success if code is valid", async () => {
    const user = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(user).toBeTruthy();
    invariant(user);

    await authService.createEmailVerificationCode(user.id, randomEmail);

    const emailVerificationCode =
      await dbTest.query.emailVerificationCodes.findFirst({
        where: eq(schema.emailVerificationCodes.userId, user.id),
      });

    expect(emailVerificationCode).toBeTruthy();
    invariant(emailVerificationCode);

    const verifyEmailCodeResult = await authService.verifyEmailCode(
      user,
      emailVerificationCode.code
    );

    expect(verifyEmailCodeResult.type).toEqual("success");
    invariant(verifyEmailCodeResult.type === "success");

    const updatedUser = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(updatedUser).toBeTruthy();
    invariant(updatedUser);

    expect(updatedUser.emailVerified).toEqual(true);
  });

  test("verifyEmailCode should return expired_code if code is expired", async () => {
    const user = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(user).toBeTruthy();
    invariant(user);

    await authService.createEmailVerificationCode(user.id, randomEmail);

    const emailVerificationCode =
      await dbTest.query.emailVerificationCodes.findFirst({
        where: eq(schema.emailVerificationCodes.userId, user.id),
      });

    expect(emailVerificationCode).toBeTruthy();
    invariant(emailVerificationCode);

    await dbTest
      .update(schema.emailVerificationCodes)
      .set({
        expiresAt: createDate(new TimeSpan(-1, "m")),
      })
      .where(eq(schema.emailVerificationCodes.userId, user.id));

    const verifyEmailCodeResult = await authService.verifyEmailCode(
      user,
      emailVerificationCode.code
    );

    expect(verifyEmailCodeResult.type).toEqual("failure");
    invariant(verifyEmailCodeResult.type === "failure");

    expect(verifyEmailCodeResult.error).toEqual("expired_code");
  });

  test("verifyEmailCode should return invalid_code if code is invalid", async () => {
    const user = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(user).toBeTruthy();
    invariant(user);

    const verifyEmailCodeResult = await authService.verifyEmailCode(
      user,
      "wrong"
    );

    expect(verifyEmailCodeResult.type).toEqual("failure");
    invariant(verifyEmailCodeResult.type === "failure");

    expect(verifyEmailCodeResult.error).toEqual("invalid_code");
  });

  test("logout should invalidate all user sessions", async () => {
    const user = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(user).toBeTruthy();
    invariant(user);

    const session = await dbTest.query.sessions.findFirst({
      where: eq(schema.sessions.userId, user.id),
    });

    expect(session).toBeTruthy();
    invariant(session);

    const logoutResult = await authService.logout(session.id);

    expect(logoutResult.type).toEqual("success");

    const updatedSession = await dbTest.query.sessions.findFirst({
      where: eq(schema.sessions.id, session.id),
    });

    // That session should be gone
    expect(updatedSession).toBeFalsy();
  });

  test("resetPasswordRequest should return success if email is found", async () => {
    const sendResetPasswordEmailSpy = spyOn(
      mockEmailService,
      "sendResetPasswordEmail"
    );

    expect(sendResetPasswordEmailSpy).toHaveBeenCalledTimes(0);
    const resetPasswordRequestResult = await authService.resetPasswordRequest(
      "https://test.com",
      randomEmail
    );

    expect(sendResetPasswordEmailSpy).toHaveBeenCalledTimes(1);
    const lastCall = sendResetPasswordEmailSpy.mock.lastCall;
    invariant(lastCall);

    expect(lastCall[0]).toEqual(randomEmail);
    expect(lastCall[1]).toContain("https://test.com/reset-password?token=");

    expect(resetPasswordRequestResult.type).toEqual("success");

    const user = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });
    invariant(user);

    const passwordResetToken = await dbTest.query.passwordResetTokens.findFirst(
      {
        where: eq(schema.passwordResetTokens.userId, user.id),
      }
    );

    expect(passwordResetToken).toBeTruthy();
    invariant(passwordResetToken);

    expect(passwordResetToken.userId).toEqual(user.id);
    expect(passwordResetToken.expiresAt).toBeTruthy();
    expect(passwordResetToken.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const twoHoursLater = createDate(new TimeSpan(2, "h"));
    expect(passwordResetToken.expiresAt.getTime()).toBeLessThan(
      twoHoursLater.getTime()
    );
  });

  test("resetPasswordRequest should return email_not_found if email is not found", async () => {
    const resetPasswordRequestResult = await authService.resetPasswordRequest(
      "test.com",
      "fake"
    );

    expect(resetPasswordRequestResult.type).toEqual("failure");
    invariant(resetPasswordRequestResult.type === "failure");

    expect(resetPasswordRequestResult.error).toEqual("email_not_found");
  });

  test("resetPasswordRequest should return email_send_error if email service fails", async () => {
    const sendResetPasswordEmailSpy = spyOn(
      mockEmailService,
      "sendResetPasswordEmail"
    );

    sendResetPasswordEmailSpy.mockImplementationOnce(() =>
      Promise.resolve({ type: "failure", error: "email_send_error" })
    );

    const resetPasswordRequestResult = await authService.resetPasswordRequest(
      "test.com",
      randomEmail
    );

    expect(resetPasswordRequestResult.type).toEqual("failure");
    invariant(resetPasswordRequestResult.type === "failure");

    expect(resetPasswordRequestResult.error).toEqual("email_send_error");
  });

  test("resetPassword should return success if code is valid", async () => {
    const user = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(user).toBeTruthy();
    invariant(user);

    const response = await authService.resetPasswordRequest(
      "test.com",
      user.email
    );

    expect(response.type).toEqual("success");
    invariant(response.type === "success");

    const newPassword = "newPassword";
    const resetPasswordResult = await authService.resetPassword(
      newPassword,
      response.data.tokenId
    );

    expect(resetPasswordResult.type).toEqual("success");
    invariant(resetPasswordResult.type === "success");

    const updatedUser = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(updatedUser).toBeTruthy();
    invariant(updatedUser);

    const isMatch = await Bun.password.verify(
      newPassword,
      updatedUser.passwordHash
    );

    expect(isMatch).toEqual(true);
  });

  test("resetPassword should return invalid_code if code is invalid", async () => {
    const resetPasswordResult = await authService.resetPassword(
      "newPassword",
      "fake"
    );

    expect(resetPasswordResult.type).toEqual("failure");
    invariant(resetPasswordResult.type === "failure");
    expect(resetPasswordResult.error).toEqual("invalid_code");
  });

  test("resetPassword should return code_expired if code is expired", async () => {
    const user = await dbTest.query.users.findFirst({
      where: eq(schema.users.email, randomEmail),
    });

    expect(user).toBeTruthy();
    invariant(user);

    const response = await authService.resetPasswordRequest(
      "test.com",
      user.email
    );

    expect(response.type).toEqual("success");
    invariant(response.type === "success");

    await dbTest
      .update(schema.passwordResetTokens)
      .set({
        expiresAt: createDate(new TimeSpan(-1, "m")),
      })
      .where(eq(schema.passwordResetTokens.userId, user.id));

    const resetPasswordResult = await authService.resetPassword(
      "newPassword",
      response.data.tokenId
    );

    expect(resetPasswordResult.type).toEqual("failure");
    invariant(resetPasswordResult.type === "failure");
    expect(resetPasswordResult.error).toEqual("code_expired");
  });
});
