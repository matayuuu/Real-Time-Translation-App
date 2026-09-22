export type AuthenticationErrorCode =
  | "login-required"
  | "cancelled"
  | "timeout"
  | "cli-unavailable"
  | "configuration"
  | "request-failed";

export class AuthenticationError extends Error {
  public override readonly name = "AuthenticationError";

  public constructor(
    public readonly code: AuthenticationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
