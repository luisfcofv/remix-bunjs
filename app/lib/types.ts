import type { User as UserDB } from "../../db/schema";

export type Result<T, E = never> =
  | {
      type: "success";
      data: T;
    }
  | {
      type: "failure";
      error: E;
    };

export type AsyncResult<T, E = never> = Promise<Result<T, E>>;

export type User = Pick<UserDB, "id" | "email" | "emailVerified">;

// Interfaces

export interface AuthServiceInterface {
  signup: (_: {
    email: string;
    password: string;
  }) => AsyncResult<{ sessionId: string }, "user_exists">;

  login: (_: {
    email: string;
    password: string;
  }) => AsyncResult<
    { sessionId: string },
    "invalid_credentials" | "user_not_found"
  >;

  logout: (sessionId: string) => AsyncResult<null>;

  createEmailVerificationCode(
    userId: string,
    email: string
  ): AsyncResult<null, "email_send_error">;

  validateSession: (
    sessionId: string
  ) => AsyncResult<{ user: User; freshSessionId?: string }, "invalid_session">;

  verifyEmailCode: (
    user: User,
    code: string
  ) => AsyncResult<{ sessionId: string }, "invalid_code" | "expired_code">;

  resetPasswordRequest: (
    domain: string,
    email: string
  ) => AsyncResult<{ tokenId: string }, "email_not_found" | "email_send_error">;

  resetPassword: (
    newPassword: string,
    token: string
  ) => AsyncResult<{ sessionId: string }, "invalid_code" | "code_expired">;
}

export interface EmailServiceInterface {
  sendConfirmEmail: (
    email: string,
    code: string
  ) => AsyncResult<null, "email_send_error">;

  sendResetPasswordEmail: (
    email: string,
    verificationLink: string
  ) => AsyncResult<null, "email_send_error">;
}
