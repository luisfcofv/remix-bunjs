import { eq } from "drizzle-orm";
import { BunSQLiteAdapter } from "@lucia-auth/adapter-sqlite";
import { Lucia, generateIdFromEntropySize } from "lucia";
import { TimeSpan, createDate } from "oslo";
import { alphabet, generateRandomString } from "oslo/crypto";
import type Database from "bun:sqlite";

import * as schema from "../../db/schema";
import { getDrizzle } from "../db";

import type {
  AsyncResult,
  AuthServiceInterface,
  EmailServiceInterface,
  User,
} from "../lib/types";

function initializeLucia(database: Database) {
  const adapter = new BunSQLiteAdapter(database, {
    user: "user",
    session: "session",
  });

  return new Lucia(adapter, {
    sessionCookie: {
      attributes: {
        secure: true,
      },
    },
    getUserAttributes: ({
      id,
      email,
      email_verified,
    }): Pick<schema.User, "id" | "email" | "emailVerified"> => ({
      id,
      email,
      emailVerified: email_verified === 1,
    }),
  });
}

export class AuthService implements AuthServiceInterface {
  public lucia: ReturnType<typeof initializeLucia>;
  private drizzle: ReturnType<typeof getDrizzle>;

  constructor(
    database: Database,
    private readonly emailServiceInterface: EmailServiceInterface
  ) {
    this.lucia = initializeLucia(database);
    this.drizzle = getDrizzle(database);
  }

  async validateSession(
    sessionId: string
  ): AsyncResult<{ user: User; freshSessionId?: string }, "invalid_session"> {
    const { session, user } = await this.lucia.validateSession(sessionId);

    if (user === null) {
      return { type: "failure", error: "invalid_session" };
    }

    if (session?.fresh) {
      return { type: "success", data: { user, freshSessionId: session.id } };
    }

    return { type: "success", data: { user } };
  }

  async signup({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): AsyncResult<{ sessionId: string }, "user_exists"> {
    const user = await this.drizzle.query.users.findFirst({
      where: eq(schema.users.email, email),
    });

    if (user != null) {
      return { type: "failure", error: "user_exists" };
    }

    const passwordHash = await Bun.password.hash(password);
    const userId = generateIdFromEntropySize(10);
    await this.drizzle.insert(schema.users).values({
      id: userId,
      email,
      passwordHash,
    });

    await this.createEmailVerificationCode(userId, email);

    const session = await this.lucia.createSession(userId, {});
    return {
      type: "success",
      data: { sessionId: session.id },
    };
  }

  async login({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): AsyncResult<
    { sessionId: string },
    "invalid_credentials" | "user_not_found"
  > {
    const user = await this.drizzle.query.users.findFirst({
      where: eq(schema.users.email, email),
    });

    if (user == null) {
      return { type: "failure", error: "user_not_found" };
    }

    const isMatch = await Bun.password.verify(password, user.passwordHash);
    if (isMatch === false) {
      return { type: "failure", error: "invalid_credentials" };
    }

    const session = await this.lucia.createSession(user.id, {});
    return {
      type: "success",
      data: {
        sessionId: session.id,
      },
    };
  }

  async createEmailVerificationCode(
    userId: string,
    email: string
  ): AsyncResult<null, "email_send_error"> {
    await this.drizzle
      .delete(schema.emailVerificationCodes)
      .where(eq(schema.emailVerificationCodes.userId, userId));

    const code = generateRandomString(8, alphabet("0-9"));
    await this.drizzle.insert(schema.emailVerificationCodes).values({
      userId,
      email,
      code,
      expiresAt: createDate(new TimeSpan(15, "m")),
    });

    const emailServiceResponse =
      await this.emailServiceInterface.sendConfirmEmail(email, code);

    if (emailServiceResponse.type === "failure") {
      return { type: "failure", error: "email_send_error" };
    }

    return { type: "success", data: null };
  }

  async verifyEmailCode(
    user: User,
    code: string
  ): AsyncResult<{ sessionId: string }, "invalid_code" | "expired_code"> {
    const response = await this.checkEmailCode(user, code);
    if (response === "invalid") {
      return { type: "failure", error: "invalid_code" };
    }

    if (response === "expired") {
      return { type: "failure", error: "expired_code" };
    }

    await this.drizzle
      .update(schema.users)
      .set({
        emailVerified: true,
      })
      .where(eq(schema.users.id, user.id));

    await this.lucia.invalidateUserSessions(user.id);
    const session = await this.lucia.createSession(user.id, {});

    return {
      type: "success",
      data: {
        sessionId: session.id,
      },
    };
  }

  async logout(sessionId: string): AsyncResult<null> {
    try {
      await this.lucia.invalidateSession(sessionId);
    } catch (error) {
      console.error("Error invalidating session", error);
    }

    return { type: "success", data: null };
  }

  async resetPasswordRequest(
    domain: string,
    email: string
  ): AsyncResult<{ tokenId: string }, "email_not_found" | "email_send_error"> {
    const user = await this.drizzle.query.users.findFirst({
      where: eq(schema.users.email, email),
    });

    if (user == null) {
      return { type: "failure", error: "email_not_found" };
    }

    const tokenId = await this.createPasswordResetToken(user.id);

    const verificationLink = `${domain}/reset-password?token=${tokenId}`;
    const emailServiceResponse =
      await this.emailServiceInterface.sendResetPasswordEmail(
        email,
        verificationLink
      );

    if (emailServiceResponse.type === "failure") {
      return { type: "failure", error: "email_send_error" };
    }

    return { type: "success", data: { tokenId } };
  }

  async resetPassword(
    newPassword: string,
    token: string
  ): AsyncResult<{ sessionId: string }, "invalid_code" | "code_expired"> {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(token);
    const tokenHash = hasher.digest("hex");

    const passwordResetToken =
      await this.drizzle.query.passwordResetTokens.findFirst({
        where: eq(schema.passwordResetTokens.tokenHash, tokenHash),
      });

    if (passwordResetToken == null) {
      return { type: "failure", error: "invalid_code" };
    }

    if (passwordResetToken.expiresAt.getTime() < Date.now()) {
      return { type: "failure", error: "code_expired" };
    }

    await this.lucia.invalidateUserSessions(passwordResetToken.userId);

    const passwordHash = await Bun.password.hash(newPassword);
    await this.drizzle
      .update(schema.users)
      .set({ passwordHash })
      .where(eq(schema.users.id, passwordResetToken.userId));

    const session = await this.lucia.createSession(
      passwordResetToken.userId,
      {}
    );

    return {
      type: "success",
      data: { sessionId: session.id },
    };
  }

  private async checkEmailCode(
    user: User,
    code: string
  ): Promise<"valid" | "expired" | "invalid"> {
    const emailVerificationCode =
      await this.drizzle.query.emailVerificationCodes.findFirst({
        where: eq(schema.emailVerificationCodes.userId, user.id),
      });

    if (!emailVerificationCode) {
      return "invalid";
    }

    if (code !== emailVerificationCode.code) {
      return "invalid";
    }

    await this.drizzle
      .delete(schema.emailVerificationCodes)
      .where(eq(schema.emailVerificationCodes.id, emailVerificationCode.id));

    if (emailVerificationCode.expiresAt.getTime() < Date.now()) {
      return "expired";
    }

    if (emailVerificationCode.email !== user.email) {
      return "expired";
    }

    return "valid";
  }

  private async createPasswordResetToken(userId: string): Promise<string> {
    await this.drizzle
      .delete(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, userId));

    // 40 character
    const tokenId = generateIdFromEntropySize(25);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(tokenId);
    const tokenHash = hasher.digest("hex");

    await this.drizzle.insert(schema.passwordResetTokens).values({
      tokenHash,
      userId,
      expiresAt: createDate(new TimeSpan(2, "h")),
    });

    return tokenId;
  }

  [Symbol.dispose]() {
    console.log("disposing AuthService");
  }
}

declare module "lucia" {
  interface Register {
    Lucia: ReturnType<typeof initializeLucia>;
    DatabaseUserAttributes: {
      id: string;
      email: string;
      email_verified: number;
    };
  }
}
