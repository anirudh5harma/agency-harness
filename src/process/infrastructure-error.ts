export type InfrastructureErrorCode =
  | "NOT_GIT_REPOSITORY"
  | "GIT_COMMAND_FAILED"
  | "GIT_EXCLUDE_SETUP_FAILED"
  | "GIT_BASELINE_VIOLATED"
  | "GIT_CHECKPOINT_INVALID"
  | "GIT_CHECKPOINT_NOT_FOUND"
  | "GIT_CHECKPOINT_PATH_TOO_LARGE"
  | "GIT_DESTRUCTIVE_CONFIRMATION_REQUIRED"
  | "GIT_UNSAFE_PATH"
  | "GIT_WORKTREE_DIRTY"
  | "GIT_WORKTREE_NOT_OWNED"
  | "GIT_UNBORN_HEAD"
  | "COMMAND_SPAWN_FAILED"
  | "COMMAND_TERMINATION_FAILED"
  | "PACKAGE_METADATA_INVALID"
  | "METADATA_READ_FAILED"
  | "METADATA_WRITE_FAILED"
  | "METADATA_INVALID"
  | "CHECKPOINT_INITIALIZATION_FAILED"
  | "CHECKPOINT_READ_FAILED"
  | "CHECKPOINT_CLOSE_FAILED"
  | "CHECKPOINT_DELETE_FAILED"
  | "TRAJECTORY_WRITE_FAILED"
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
