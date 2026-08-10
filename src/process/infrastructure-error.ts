export type InfrastructureErrorCode =
  | "NOT_GIT_REPOSITORY"
  | "GIT_COMMAND_FAILED"
  | "PACKAGE_METADATA_INVALID"
  | "METADATA_READ_FAILED"
  | "METADATA_WRITE_FAILED"
  | "METADATA_INVALID"
  | "CODING_RUNTIME_RESULT_UNAVAILABLE"
  | "PI_RUNTIME_INITIALIZATION_FAILED"
  | "PI_SESSION_CREATION_FAILED"
  | "PI_PROVIDER_REQUEST_FAILED"
  | "PI_PLAN_INVALID"
  | "PI_PLAN_MISSING";

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
