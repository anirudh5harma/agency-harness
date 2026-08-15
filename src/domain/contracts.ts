import { z } from "zod";

const NonEmptyStringSchema = z.string().trim().min(1);
export function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/gu, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED]")
    .replace(
      /(\baws[_ -]?(?:access[_ -]?key[_ -]?id|secret[_ -]?access[_ -]?key|session[_ -]?token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
      "$1[REDACTED]",
    );
}
const HumanDecisionIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const HumanDecisionTextSchema = z.string().trim().min(1).max(1_000).transform(redactSecrets);
function containsTerminalSpoofingControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || /\p{Cf}/u.test(character);
  });
}

function terminalSafeApprovalText(value: string, context: z.RefinementCtx, path: PropertyKey[]): void {
  if (containsTerminalSpoofingControl(value)) {
    context.addIssue({
      code: "custom",
      path,
      message: "approval presentation cannot contain terminal control or directionality characters",
    });
  }
}

export const HumanDecisionOptionSchema = z.strictObject({
  id: HumanDecisionIdSchema,
  label: z.string().trim().min(1).max(80).transform(redactSecrets),
  description: z.string().trim().min(1).max(240).transform(redactSecrets),
});
export type HumanDecisionOption = z.infer<typeof HumanDecisionOptionSchema>;

export const APPROVAL_DECISION_OPTIONS: readonly HumanDecisionOption[] = Object.freeze([
  Object.freeze({ id: "approve", label: "Approve", description: "Run this exact action once." }),
  Object.freeze({ id: "reject", label: "Reject", description: "Cancel this action." }),
  Object.freeze({ id: "edit", label: "Edit", description: "Provide different guidance; do not run the original action." }),
]);

export const HumanDecisionRequestSchema = z
  .strictObject({
    id: HumanDecisionIdSchema,
    kind: z.enum(["clarification", "approval"]),
    question: HumanDecisionTextSchema,
    context: HumanDecisionTextSchema.optional(),
    risk: HumanDecisionTextSchema.optional(),
    /** Exact normalized command or action governed by an approval. */
    action: HumanDecisionTextSchema.optional(),
    options: z.array(HumanDecisionOptionSchema).min(2).max(3),
    allowCustom: z.boolean(),
  })
  .superRefine((request, context) => {
    const ids = request.options.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["options"], message: "option ids must be unique" });
    }
    if (request.kind === "clarification" && !request.allowCustom) {
      context.addIssue({ code: "custom", path: ["allowCustom"], message: "clarifications must allow custom input" });
    }
    if (request.kind === "approval") {
      if (!request.allowCustom) {
        context.addIssue({ code: "custom", path: ["allowCustom"], message: "approval edits require custom input" });
      }
      if (request.action === undefined) {
        context.addIssue({ code: "custom", path: ["action"], message: "approvals require an exact action" });
      }
      if (ids.length !== 3 || !["approve", "reject", "edit"].every((id) => ids.includes(id))) {
        context.addIssue({
          code: "custom",
          path: ["options"],
          message: "approvals require approve, reject, and edit options",
        });
      }
      terminalSafeApprovalText(request.question, context, ["question"]);
      if (request.action !== undefined) terminalSafeApprovalText(request.action, context, ["action"]);
      request.options.forEach((option, index) => {
        terminalSafeApprovalText(option.label, context, ["options", index, "label"]);
        terminalSafeApprovalText(option.description, context, ["options", index, "description"]);
      });
    }
  })
  .transform((request) => request.kind === "approval"
    ? { ...request, options: APPROVAL_DECISION_OPTIONS.map((option) => ({ ...option })) }
    : request);
export type HumanDecisionRequest = z.infer<typeof HumanDecisionRequestSchema>;

const HumanDecisionResponseBaseSchema = z
  .strictObject({
    requestId: HumanDecisionIdSchema,
    optionId: HumanDecisionIdSchema.optional(),
    customText: HumanDecisionTextSchema.optional(),
  })
  .superRefine((response, context) => {
    if ((response.optionId === undefined) === (response.customText === undefined)) {
      context.addIssue({
        code: "custom",
        message: "choose exactly one option or provide custom text",
      });
    }
  });

export const HumanDecisionResponseSchema = Object.assign(HumanDecisionResponseBaseSchema, {
  forRequest(request: HumanDecisionRequest) {
    return HumanDecisionResponseBaseSchema.superRefine((response, context) => {
      if (response.requestId !== request.id) {
        context.addIssue({ code: "custom", path: ["requestId"], message: "request id does not match" });
      }
      if (
        response.optionId !== undefined &&
        !request.options.some(({ id }) => id === response.optionId)
      ) {
        context.addIssue({ code: "custom", path: ["optionId"], message: "unknown option" });
      }
      if (response.customText !== undefined && !request.allowCustom) {
        context.addIssue({ code: "custom", path: ["customText"], message: "custom input is not allowed" });
      }
    });
  },
});
export type HumanDecisionResponse = z.infer<typeof HumanDecisionResponseBaseSchema>;

export const HumanDecisionResolutionSchema = z.strictObject({
  request: HumanDecisionRequestSchema,
  response: HumanDecisionResponseBaseSchema,
}).superRefine(({ request, response }, context) => {
  const parsed = HumanDecisionResponseSchema.forRequest(request).safeParse(response);
  for (const issue of parsed.success ? [] : parsed.error.issues) {
    context.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});
export type HumanDecisionResolution = z.infer<typeof HumanDecisionResolutionSchema>;

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
  stdoutTruncated: z.boolean().optional(),
  stderrTruncated: z.boolean().optional(),
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
  stage: z.enum([
    "preparing",
    "planning",
    "executing",
    "verifying",
    "repairing",
    "finalizing",
  ]),
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

export const MAX_SESSION_TURNS = 20;
export const MAX_SESSION_RUN_SUMMARIES = 10;
export const MAX_OLDER_SUMMARY_CHARS = 12_000;
export const EXPLICIT_COMPACT_TURNS = 6;
export const EXPLICIT_COMPACT_RUN_SUMMARIES = 4;

export const ProjectKnowledgeEntrySchema = z.strictObject({
  category: z.enum(["architecture", "decision", "learning"]),
  text: z.string()
    .regex(/^[^\r\n]*$/u, "Project knowledge entries must be a single line")
    .trim()
    .min(1)
    .max(500)
    .transform(redactSecrets),
});
export type ProjectKnowledgeEntry = z.infer<typeof ProjectKnowledgeEntrySchema>;

const projectKnowledgeCategories = ["architecture", "decision", "learning"] as const;
const projectKnowledgeTitles = {
  architecture: "Architecture",
  decision: "Decisions",
  learning: "Learnings",
} as const;

export function projectKnowledgeKey(entry: ProjectKnowledgeEntry): string {
  return `${entry.category}:${entry.text.toLocaleLowerCase()}`;
}

export function renderProjectKnowledge(
  entries: readonly ProjectKnowledgeEntry[],
): string {
  if (entries.length === 0) return "None.";
  return projectKnowledgeCategories
    .map((category) => {
      const lines = entries
        .filter((entry) => entry.category === category)
        .map(({ text }) => `- ${text}`);
      return lines.length === 0
        ? ""
        : `${projectKnowledgeTitles[category]}:\n${lines.join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12_000);
}

export const ProjectKnowledgeSchema = z.strictObject({
  entries: z.array(ProjectKnowledgeEntrySchema).max(300).default([]),
});
export type ProjectKnowledge = z.infer<typeof ProjectKnowledgeSchema>;

export const SessionTurnSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: NonEmptyStringSchema,
});
export type SessionTurn = z.infer<typeof SessionTurnSchema>;

export const RunSummaryStatusSchema = z.enum(["completed", "failed"]);
export type RunSummaryStatus = z.infer<typeof RunSummaryStatusSchema>;

export const RunSummarySchema = z.strictObject({
  runId: NonEmptyStringSchema,
  status: RunSummaryStatusSchema,
  objective: NonEmptyStringSchema,
  summary: z.string(),
  verification: VerificationResultSchema.optional(),
  changedFiles: z.array(NonEmptyStringSchema).optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const SessionContextSchema = z.strictObject({
  sessionId: NonEmptyStringSchema,
  olderSummary: z.string().max(MAX_OLDER_SUMMARY_CHARS).default(""),
  compactionCount: z.number().int().nonnegative().default(0),
  lastCompactedAt: z.iso.datetime().nullable().default(null),
  recentTurns: z
    .array(SessionTurnSchema)
    .max(MAX_SESSION_TURNS)
    .default([]),
  runSummaries: z
    .array(RunSummarySchema)
    .max(MAX_SESSION_RUN_SUMMARIES)
    .default([]),
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
  z.strictObject({ type: z.literal("model_turn") }),
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
  z.strictObject({
    type: z.literal("assistant_text_delta"),
    delta: z.string().max(65_536),
    done: z.boolean(),
  }).refine(({ delta, done }) => done || delta.length > 0, {
    message: "assistant text deltas must contain text unless ending the message",
  }),
  z.strictObject({
    type: z.literal("context_compacted"),
    beforeTurns: z.number().int().nonnegative(),
    afterTurns: z.number().int().nonnegative(),
    beforeRunSummaries: z.number().int().nonnegative(),
    afterRunSummaries: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal("error"), message: NonEmptyStringSchema }),
  z.strictObject({
    type: z.literal("human_input_requested"),
    requestId: HumanDecisionIdSchema,
    kind: z.enum(["clarification", "approval"]),
    question: HumanDecisionTextSchema,
    options: z.array(z.strictObject({
      id: HumanDecisionIdSchema,
      label: z.string().trim().min(1).max(80).transform(redactSecrets),
    })).min(2).max(3),
  }),
  z.strictObject({
    type: z.literal("human_input_resolved"),
    requestId: HumanDecisionIdSchema,
    resolution: HumanDecisionIdSchema.or(z.literal("custom")),
  }),
]);
export type AgencyEvent = z.infer<typeof AgencyEventSchema>;
