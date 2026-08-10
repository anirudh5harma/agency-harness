import { z } from "zod";

const NonEmptyStringSchema = z.string().trim().min(1);

export const PlanStepSchema = z.strictObject({
  id: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.strictObject({
  objective: NonEmptyStringSchema,
  assumptions: z.array(NonEmptyStringSchema).default([]),
  steps: z.array(PlanStepSchema).min(1),
  likelyFiles: z.array(NonEmptyStringSchema).default([]),
  verificationStrategy: z.array(NonEmptyStringSchema).min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

export const ProjectMetadataSchema = z.strictObject({
  name: NonEmptyStringSchema,
  version: NonEmptyStringSchema.optional(),
  description: NonEmptyStringSchema.optional(),
  languages: z.array(NonEmptyStringSchema).default([]),
  packageManager: NonEmptyStringSchema.optional(),
  scripts: z.record(z.string(), NonEmptyStringSchema).default({}),
});
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

export const RepoContextSchema = z.strictObject({
  rootPath: NonEmptyStringSchema,
  currentBranch: NonEmptyStringSchema.nullable().default(null),
  defaultBranch: NonEmptyStringSchema.nullable().default(null),
  isDirty: z.boolean().default(false),
  project: ProjectMetadataSchema,
});
export type RepoContext = z.infer<typeof RepoContextSchema>;

export const CommandResultSchema = z.strictObject({
  command: NonEmptyStringSchema,
  args: z.array(z.string()).default([]),
  exitCode: z.number().int().nullable(),
  signal: NonEmptyStringSchema.nullable().default(null),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().finite().nonnegative(),
  timedOut: z.boolean().default(false),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const VerificationStatusSchema = z.enum(["passed", "failed", "skipped"]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const VerificationResultSchema = z.strictObject({
  status: VerificationStatusSchema,
  summary: NonEmptyStringSchema,
  commands: z.array(CommandResultSchema).default([]),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const FailureContextSchema = z.strictObject({
  stage: z.enum(["preparing", "planning", "executing", "verifying", "repairing"]),
  message: NonEmptyStringSchema,
  cause: z.string().optional(),
  recoverable: z.boolean().default(false),
  command: CommandResultSchema.optional(),
});
export type FailureContext = z.infer<typeof FailureContextSchema>;

export const RunStatusSchema = z.enum([
  "preparing",
  "planning",
  "executing",
  "verifying",
  "repairing",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunStateSchema = z.strictObject({
  runId: NonEmptyStringSchema,
  threadId: NonEmptyStringSchema,
  repoPath: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  status: RunStatusSchema,
  userIntent: NonEmptyStringSchema,
  repoContext: RepoContextSchema.nullable().default(null),
  plan: PlanSchema.nullable().default(null),
  currentStepId: NonEmptyStringSchema.nullable().default(null),
  completedStepIds: z.array(NonEmptyStringSchema).default([]),
  attempt: z.number().int().nonnegative().default(0),
  maxRepairAttempts: z.number().int().positive().default(2),
  changedFiles: z.array(NonEmptyStringSchema).default([]),
  verification: VerificationResultSchema.nullable().default(null),
  failure: FailureContextSchema.nullable().default(null),
  summary: z.string().default(""),
});
export type RunState = z.infer<typeof RunStateSchema>;

export const SessionTurnSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: NonEmptyStringSchema,
});
export type SessionTurn = z.infer<typeof SessionTurnSchema>;

export const RunSummarySchema = z.strictObject({
  runId: NonEmptyStringSchema,
  status: RunStatusSchema,
  objective: NonEmptyStringSchema,
  summary: z.string(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const SessionContextSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  recentTurns: z.array(SessionTurnSchema).max(20).default([]),
  runSummaries: z.array(RunSummarySchema).max(10).default([]),
});
export type SessionContext = z.infer<typeof SessionContextSchema>;

export const AgencyPhaseSchema = z.enum([
  "preparing",
  "planning",
  "executing",
  "verifying",
  "repairing",
]);
export type AgencyPhase = z.infer<typeof AgencyPhaseSchema>;

export const AgencyEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("phase"), phase: AgencyPhaseSchema }),
  z.strictObject({
    type: z.literal("tool"),
    tool: NonEmptyStringSchema,
    detail: NonEmptyStringSchema.optional(),
  }),
  z.strictObject({ type: z.literal("file_changed"), path: NonEmptyStringSchema }),
  z.strictObject({
    type: z.literal("command_started"),
    command: NonEmptyStringSchema,
  }),
  z.strictObject({
    type: z.literal("command_finished"),
    command: NonEmptyStringSchema,
    exitCode: z.number().int(),
    durationMs: z.number().finite().nonnegative(),
  }),
  z.strictObject({ type: z.literal("message"), content: NonEmptyStringSchema }),
  z.strictObject({ type: z.literal("error"), message: NonEmptyStringSchema }),
]);
export type AgencyEvent = z.infer<typeof AgencyEventSchema>;
