export type InfrastructureErrorCode =
  | "NOT_GIT_REPOSITORY"
  | "GIT_COMMAND_FAILED"
  | "PACKAGE_METADATA_INVALID";

export class InfrastructureError extends Error {
  readonly code: InfrastructureErrorCode;
  override readonly cause?: unknown;

  constructor(
    code: InfrastructureErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = "InfrastructureError";
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}
