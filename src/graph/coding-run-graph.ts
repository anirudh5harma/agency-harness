import {
  Command,
  END,
  START,
  StateGraph,
  StateSchema,
  interrupt,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";

import type { CodingRuntime } from "../coding/index.js";
import {
  FailureContextSchema,
  HumanDecisionRequestSchema,
  HumanDecisionResolutionSchema,
  HumanDecisionResponseSchema,
  PlanSchema,
  projectKnowledgeKey,
  ProjectKnowledgeEntrySchema,
  ProjectKnowledgeSchema,
  RepoContextSchema,
  SessionContextSchema,
  type AgencyPhase,
  type FailureContext,
  type ProjectKnowledgeEntry,
  type VerificationResult,
} from "../domain/index.js";
import type { EventBus } from "../events/index.js";
import type {
  TrajectoryLifecycleEvent,
  TrajectoryMetadata,
  TrajectoryWriter,
} from "../observability/index.js";
import type {
  IncompleteRunEntry,
  IncompleteRunRegistry,
} from "../persistence/index.js";
import { ProjectKnowledgeStore, type ProjectKnowledgeStoreBoundary } from "../persistence/index.js";
import {
  VerificationRunner,
  detectNodeVerificationCommands,
  InfrastructureError,
  type VerificationCommand,
} from "../process/index.js";
import {
  captureGitBaseline,
  ensureAgencyMetadataIgnored,
  getChangedFiles,
  inspectRepository,
  type GitBaseline,
  type GitFileChange,
  type RepositoryInspection,
} from "../repo/index.js";

const MAX_CHANGED_FILES = 2_000;
const MAX_BASELINE_PATHS = 100_000;
const MAX_COMMANDS = 20;
const MAX_TEXT = 8_000;
const MAX_REPO_INSTRUCTIONS = 12_000;
const IdentifierSchema = z.string().trim().min(1).max(128);
const TextSchema = z.string().max(MAX_TEXT);
const RuntimeContinuationSchema = z.strictObject({
  role: z.enum(["planner", "executor"]),
  sessionFile: z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+\.jsonl$/u),
});

const BoundedPlanSchema = PlanSchema.superRefine((plan, context) => {
  const limits = [
    ["assumptions", plan.assumptions.length, 50],
    ["steps", plan.steps.length, 100],
    ["likelyFiles", plan.likelyFiles.length, MAX_CHANGED_FILES],
    ["verificationStrategy", plan.verificationStrategy.length, 50],
  ] as const;
  for (const [field, length, maximum] of limits) {
    if (length > maximum) {
      context.addIssue({
        code: "too_big",
        origin: "array",
        maximum,
        inclusive: true,
        path: [field],
        message: `${field} exceeds its bounded maximum`,
      });
    }
  }
});
const BoundedVerificationSchema = z.strictObject({
  status: z.enum(["passed", "failed", "skipped"]),
  summary: z.string().trim().min(1).max(MAX_TEXT),
  commands: z
    .array(
      z.strictObject({
        command: z.string().trim().min(1).max(1_000),
        args: z.array(z.string().max(2_000)).max(100),
        exitCode: z.number().int().nullable(),
        signal: z.string().trim().min(1).max(100).nullable(),
        stdout: TextSchema,
        stderr: TextSchema,
        durationMs: z.number().finite().nonnegative(),
        timedOut: z.boolean(),
      }),
    )
    .max(MAX_COMMANDS),
});
const GitBaselineSchema = z.strictObject({
  rootPath: z.string().trim().min(1),
  commit: z.string().nullable(),
  indexTree: z.string().max(128),
  paths: z
    .record(
      z.string(),
      z.strictObject({
        tracked: z.boolean(),
        statusCode: z.string().max(2),
        identity: z.string().nullable(),
      }),
    )
    .refine((paths) => Object.keys(paths).length <= MAX_BASELINE_PATHS),
});
const VerificationCommandSchema = z.strictObject({
  name: z.string().trim().min(1).max(1_000),
  command: z.string().trim().min(1).max(1_000),
  args: z.array(z.string().max(2_000)).max(100),
  required: z.boolean(),
});
const VerificationScriptsSchema = z.record(
  z.string().trim().min(1).max(1_000),
  z.string().max(MAX_TEXT),
);

export const CodingRunStateSchema = new StateSchema({
  runId: IdentifierSchema,
  threadId: IdentifierSchema,
  sessionId: IdentifierSchema,
  repoPath: z.string().trim().min(1),
  userIntent: z.string().trim().min(1).max(MAX_TEXT),
  status: z
    .enum([
      "preparing",
      "planning",
      "executing",
      "verifying",
      "repairing",
      "completed",
      "failed",
      "cancelled",
    ])
    .default("preparing"),
  repoContext: RepoContextSchema.nullable().default(null),
  repoInstructions: z.string().max(MAX_REPO_INSTRUCTIONS).default(""),
  sessionContext: SessionContextSchema.nullable().default(null),
  projectKnowledge: ProjectKnowledgeSchema.nullable().default(null),
  proposedKnowledge: z.array(ProjectKnowledgeEntrySchema).max(300).default([]),
  codingPlan: BoundedPlanSchema.nullable().default(null),
  baseline: GitBaselineSchema.nullable().default(null),
  verificationCommands: z
    .array(VerificationCommandSchema)
    .max(MAX_COMMANDS)
    .default([]),
  verificationScripts: VerificationScriptsSchema.default({}),
  attempt: z.number().int().nonnegative().max(20).default(0),
  maxRepairAttempts: z.number().int().positive().max(20).default(2),
  changedFiles: z.array(z.string().trim().min(1)).max(MAX_CHANGED_FILES).default([]),
  verification: BoundedVerificationSchema.nullable().default(null),
  pendingHumanDecision: HumanDecisionRequestSchema.nullable().default(null),
  humanDecision: HumanDecisionResolutionSchema.nullable().default(null),
  runtimeContinuation: RuntimeContinuationSchema.nullable().default(null),
  failure: FailureContextSchema.nullable().default(null),
  executionMessage: TextSchema.default(""),
  summary: TextSchema.default(""),
  createdAt: z.iso.datetime().nullable().default(null),
  updatedAt: z.iso.datetime().nullable().default(null),
});

export type CodingRunState = typeof CodingRunStateSchema.State;
export type CodingRunInput = Pick<
  CodingRunState,
  "runId" | "threadId" | "sessionId" | "repoPath" | "userIntent"
> &
  Partial<Pick<CodingRunState, "maxRepairAttempts" | "sessionContext">>;

export interface IncompleteRunRegistryBoundary {
  readonly path?: string;
  upsert(entry: IncompleteRunEntry): Promise<void>;
  updateStatus(
    runId: string,
    status: CodingRunState["status"],
    updatedAt: string,
  ): Promise<void>;
}

export interface CodingRunGraphDependencies {
  runtime: CodingRuntime;
  inspectRepository?: (cwd: string) => Promise<RepositoryInspection>;
  loadRepoInstructions?: (
    rootPath: string,
    instructionFiles: readonly string[],
  ) => Promise<string>;
  captureGitBaseline?: (cwd: string) => Promise<GitBaseline>;
  getChangedFiles?: (baseline: GitBaseline) => Promise<GitFileChange[]>;
  detectVerificationCommands?: (cwd: string) => Promise<VerificationCommand[]>;
  runVerification?: (
    commands: readonly VerificationCommand[],
    cwd: string,
    signal: AbortSignal,
  ) => Promise<VerificationResult>;
  eventBus?: EventBus;
  trajectoryWriter?: TrajectoryWriter;
  ensureMetadataIgnored?: (rootPath: string) => Promise<void>;
  registry: IncompleteRunRegistryBoundary | IncompleteRunRegistry;
  knowledgeStore?: ProjectKnowledgeStoreBoundary;
  now?: () => Date;
}

export interface CodingRunGraphOptions {
  checkpointer?: BaseCheckpointSaver;
}

export interface InvokeCodingRunOptions {
  threadId?: string;
  signal?: AbortSignal;
}

export interface CodingRunGraphRunner {
  invoke(input: CodingRunInput, options?: InvokeCodingRunOptions): Promise<CodingRunState>;
  getState(threadId: string): Promise<unknown>;
  resume(
    threadId: string,
    response?: import("../domain/index.js").HumanDecisionResponse,
    options?: { signal?: AbortSignal },
  ): Promise<CodingRunState>;
}

type PhaseStatus = Extract<
  CodingRunState["status"],
  "preparing" | "planning" | "executing" | "verifying" | "repairing"
>;

type PhaseName = "plan" | "execution" | "verification" | "repair";

interface PhaseBoundary {
  startedAt: Date;
  result:
    | { status: PhaseStatus; updatedAt: string }
    | { status: "failed"; failure: FailureContext; updatedAt: string };
}

function concise(value: string, limit = MAX_TEXT): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function errorMessage(error: unknown): string {
  return concise(error instanceof Error ? error.message : String(error));
}

function infrastructureFailure(
  stage: FailureContext["stage"],
  error: unknown,
): FailureContext {
  const cause = error instanceof Error && error.cause !== undefined
    ? concise(String(error.cause), 2_000)
    : undefined;
  return {
    stage,
    message: errorMessage(error),
    ...(cause === undefined ? {} : { cause }),
    recoverable: false,
  };
}

function boundedVerification(result: VerificationResult): VerificationResult {
  return BoundedVerificationSchema.parse({
    ...result,
    summary: concise(result.summary),
    commands: result.commands.slice(0, MAX_COMMANDS).map((command) => ({
      ...command,
      stdout: concise(command.stdout),
      stderr: concise(command.stderr),
    })),
  });
}

function repositoryContext(inspection: RepositoryInspection) {
  return RepoContextSchema.parse({
    rootPath: inspection.rootPath,
    currentBranch: inspection.currentBranch,
    defaultBranch: inspection.defaultBranch,
    isDirty: inspection.isDirty,
    project: inspection.project,
  });
}

export async function loadRepositoryInstructions(
  rootPath: string,
  instructionFiles: readonly string[],
): Promise<string> {
  const sections: string[] = [];
  let remaining = MAX_REPO_INSTRUCTIONS;
  for (const filePath of instructionFiles) {
    const label = relative(rootPath, filePath);
    if (
      label === "" ||
      label === ".." ||
      label.startsWith(`..${sep}`)
    ) {
      throw new InfrastructureError(
        "METADATA_READ_FAILED",
        "Repository instruction path is outside the repository",
      );
    }
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (cause) {
      throw new InfrastructureError(
        "METADATA_READ_FAILED",
        `Could not read repository instructions from ${label}`,
        { cause },
      );
    }
    const safeLabel = label.split(sep).join("/");
    const header = `[${safeLabel}]\n`;
    if (header.length >= remaining) break;
    const normalized = content.trim();
    const section = `${header}${normalized.slice(0, remaining - header.length)}`;
    sections.push(section);
    remaining -= section.length + 2;
    if (remaining <= 0) break;
  }
  return sections.join("\n\n").slice(0, MAX_REPO_INSTRUCTIONS);
}

function isInternalMetadataPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized === ".devagency" || normalized.startsWith(".devagency/");
}

async function verificationScripts(
  rootPath: string,
  commands: readonly VerificationCommand[],
): Promise<Record<string, string>> {
  const scriptNames = commands
    .filter(({ command, args }) =>
      ["npm", "pnpm", "yarn", "bun"].includes(command) && args[0] === "run" && args[1] !== undefined)
    .map(({ args }) => args[1] as string);
  if (scriptNames.length === 0) return {};

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(rootPath, "package.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const scripts = typeof manifest === "object" && manifest !== null
    && "scripts" in manifest && typeof manifest.scripts === "object" && manifest.scripts !== null
    ? manifest.scripts as Record<string, unknown>
    : {};
  return VerificationScriptsSchema.parse(Object.fromEntries(
    scriptNames.flatMap((name) => typeof scripts[name] === "string" ? [[name, scripts[name]]] : []),
  ));
}

export function routeAfterVerification(
  state: CodingRunState,
): "repair" | "summarize" {
  if (state.failure?.recoverable !== true) return "summarize";
  return state.attempt < state.maxRepairAttempts ? "repair" : "summarize";
}

export function createCodingRunGraph(
  dependencies: CodingRunGraphDependencies,
  options: CodingRunGraphOptions = {},
): CodingRunGraphRunner {
  const inspect = dependencies.inspectRepository ?? inspectRepository;
  const loadInstructions =
    dependencies.loadRepoInstructions ?? loadRepositoryInstructions;
  const captureBaseline = dependencies.captureGitBaseline ?? captureGitBaseline;
  const changedFilesSince = dependencies.getChangedFiles ?? getChangedFiles;
  const detectCommands =
    dependencies.detectVerificationCommands ?? detectNodeVerificationCommands;
  const runVerification =
    dependencies.runVerification ??
    ((commands, cwd, signal) =>
      new VerificationRunner({
        ...(dependencies.eventBus === undefined ? {} : { eventBus: dependencies.eventBus }),
        signal,
      }).run(
        commands,
        cwd,
      ));
  const now = dependencies.now ?? (() => new Date());
  const ensureMetadataIgnored =
    dependencies.ensureMetadataIgnored ?? ensureAgencyMetadataIgnored;
  let knowledgeStore: ProjectKnowledgeStoreBoundary | undefined = dependencies.knowledgeStore;
  const forwardRuntimeEvent = dependencies.eventBus === undefined
    ? undefined
    : (event: Parameters<EventBus["emit"]>[0]) => {
        // Graph lifecycle owns phase events. Forwarding the runtime's duplicate
        // phase notification would render every model phase twice.
        if (event.type !== "phase") dependencies.eventBus?.emit(event);
      };

  async function recordTrajectory(
    state: Pick<CodingRunState, "runId" | "sessionId">,
    event: TrajectoryLifecycleEvent,
    options: {
      at?: Date;
      startedAt?: Date;
      metadata?: TrajectoryMetadata;
    } = {},
  ): Promise<void> {
    if (dependencies.trajectoryWriter === undefined) return;
    const at = options.at ?? now();
    await dependencies.trajectoryWriter.append({
      timestamp: at.toISOString(),
      runId: state.runId,
      sessionId: state.sessionId,
      event,
      ...(options.startedAt === undefined
        ? {}
        : { durationMs: Math.max(0, at.getTime() - options.startedAt.getTime()) }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    });
  }

  async function failureAfterRecording(
    state: Pick<CodingRunState, "runId" | "sessionId">,
    event: TrajectoryLifecycleEvent,
    startedAt: Date,
    error: unknown,
  ): Promise<unknown> {
    if (
      error instanceof InfrastructureError &&
      error.code === "TRAJECTORY_WRITE_FAILED"
    ) {
      return error;
    }
    try {
      await recordTrajectory(state, event, { startedAt });
      return error;
    } catch (writeError) {
      return writeError;
    }
  }

  async function actualChangedFiles(baseline: GitBaseline): Promise<string[]> {
    return (await changedFilesSince(baseline))
      .map(({ path }) => path)
      .filter((path) => !isInternalMetadataPath(path))
      .slice(0, MAX_CHANGED_FILES);
  }

  function mergeKnowledge(
    current: readonly ProjectKnowledgeEntry[],
    proposed: readonly ProjectKnowledgeEntry[] | undefined,
  ): ProjectKnowledgeEntry[] {
    const merged = new Map<string, ProjectKnowledgeEntry>();
    for (const raw of [...current, ...(proposed ?? [])]) {
      const entry = ProjectKnowledgeEntrySchema.parse(raw);
      const identity = projectKnowledgeKey(entry);
      if (!merged.has(identity)) merged.set(identity, entry);
    }
    return [...merged.values()].slice(0, 300);
  }

  async function recordHumanRequest(
    state: CodingRunState,
    request: import("../domain/index.js").HumanDecisionRequest,
  ): Promise<void> {
    await recordTrajectory(state, "human_input_requested", {
      metadata: {
        requestId: request.id,
        decisionKind: request.kind,
        question: concise(request.question, 1_000),
        optionLabels: request.options.map(({ label }) => concise(label, 80)),
      },
    });
    dependencies.eventBus?.emit({
      type: "human_input_requested",
      requestId: request.id,
      kind: request.kind,
      question: request.question,
      options: request.options.map(({ id, label }) => ({ id, label })),
    });
  }

  async function enterPhase(
    state: CodingRunState,
    status: PhaseStatus,
    phase: PhaseName,
  ): Promise<PhaseBoundary> {
    const startedAt = now();
    if (state.status === status && state.humanDecision !== null) {
      return { startedAt, result: { status, updatedAt: state.updatedAt ?? startedAt.toISOString() } };
    }
    const updatedAt = startedAt.toISOString();
    try {
      await recordTrajectory(state, `${phase}_started`, { at: startedAt });
      dependencies.eventBus?.emit({ type: "phase", phase: status as AgencyPhase });
      await dependencies.registry.updateStatus(state.runId, status, updatedAt);
      return { startedAt, result: { status, updatedAt } };
    } catch (error) {
      const reportedError = await failureAfterRecording(
        state,
        `${phase}_failed`,
        startedAt,
        error,
      );
      return {
        startedAt,
        result: {
          status: "failed",
          failure: infrastructureFailure(status, reportedError),
          updatedAt,
        },
      };
    }
  }

  const prepare: typeof CodingRunStateSchema.Node = async (state) => {
    const createdAt = state.createdAt ?? now().toISOString();
    let startedAt = now();
    let metadataSafe = false;
    try {
      const inspection = await inspect(state.repoPath);
      await ensureMetadataIgnored(inspection.rootPath);
      metadataSafe = true;
      knowledgeStore ??= new ProjectKnowledgeStore(inspection.rootPath);
      const projectKnowledge = await knowledgeStore.load();
      startedAt = now();
      await recordTrajectory(state, "run_started", { at: startedAt });
      await recordTrajectory(state, "prepare_started", { at: startedAt });
      dependencies.eventBus?.emit({ type: "phase", phase: "preparing" });
      await dependencies.registry.upsert({
        runId: state.runId,
        threadId: state.threadId,
        sessionId: state.sessionId,
        userIntent: state.userIntent,
        status: "preparing",
        createdAt,
        updatedAt: createdAt,
      });
      const repoInstructions = await loadInstructions(
        inspection.rootPath,
        inspection.instructionFiles,
      );
      const baseline = await captureBaseline(inspection.rootPath);
      const verificationCommands = z
        .array(VerificationCommandSchema)
        .max(MAX_COMMANDS)
        .parse(await detectCommands(inspection.rootPath));
      const preparedVerificationScripts = await verificationScripts(
        inspection.rootPath,
        verificationCommands,
      );
      await recordTrajectory(state, "prepare_completed", { startedAt });
      if (verificationCommands.length === 0) {
        const message = "No verification commands detected before model execution";
        return {
          status: "failed",
          repoPath: inspection.rootPath,
          repoContext: repositoryContext(inspection),
          repoInstructions,
          projectKnowledge,
          baseline,
          verificationCommands,
          verificationScripts: preparedVerificationScripts,
          verification: {
            status: "skipped",
            summary: message,
            commands: [],
          },
          failure: {
            stage: "verifying",
            message,
            recoverable: false,
          },
          createdAt,
          updatedAt: now().toISOString(),
        };
      }
      return {
        status: "preparing",
        repoPath: inspection.rootPath,
        repoContext: repositoryContext(inspection),
        repoInstructions,
        projectKnowledge,
        baseline,
        verificationCommands,
        verificationScripts: preparedVerificationScripts,
        createdAt,
        updatedAt: createdAt,
      };
    } catch (error) {
      const reportedError = metadataSafe
        ? await failureAfterRecording(
            state,
            "prepare_failed",
            startedAt,
            error,
          )
        : error;
      return {
        status: "failed",
        failure: infrastructureFailure("preparing", reportedError),
        createdAt,
        updatedAt: now().toISOString(),
      };
    }
  };

  const planNode: typeof CodingRunStateSchema.Node = async (state, runtime) => {
    if (state.status === "failed") return {};
    const boundary = await enterPhase(state, "planning", "plan");
    if (boundary.result.status === "failed") return boundary.result;
    if (state.repoContext === null) {
      const error = new Error("Repository context is unavailable");
      const reportedError = await failureAfterRecording(state, "plan_failed", boundary.startedAt, error);
      return { status: "failed", failure: infrastructureFailure("planning", reportedError) };
    }
    try {
      const result = await dependencies.runtime.createPlan({
        intent: state.userIntent,
        repo: state.repoContext,
        repoInstructions: state.repoInstructions,
        sessionId: state.sessionId,
        ...(state.humanDecision === null ? {} : { humanDecision: state.humanDecision }),
        ...(state.runtimeContinuation === null ? {} : { runtimeContinuation: state.runtimeContinuation }),
        ...(state.sessionContext === null ? {} : { sessionContext: state.sessionContext }),
        ...(state.projectKnowledge === null ? {} : { projectKnowledge: state.projectKnowledge }),
        signal: runtime.signal ?? new AbortController().signal,
        ...(forwardRuntimeEvent === undefined ? {} : { onEvent: forwardRuntimeEvent }),
      });
      if ("decisionRequest" in result) {
        const decisionRequest = HumanDecisionRequestSchema.parse(result.decisionRequest);
        await recordHumanRequest(state, decisionRequest);
        return {
          ...boundary.result,
          pendingHumanDecision: decisionRequest,
          humanDecision: null,
          runtimeContinuation: result.runtimeContinuation ?? null,
          executionMessage: concise(result.message),
        };
      }
      const codingPlan = BoundedPlanSchema.parse(result.plan);
      await recordTrajectory(state, "plan_completed", {
        startedAt: boundary.startedAt,
      });
      return {
        ...boundary.result,
        codingPlan,
        pendingHumanDecision: null,
        humanDecision: null,
        runtimeContinuation: null,
        executionMessage: concise(result.message),
      };
    } catch (error) {
      const reportedError = await failureAfterRecording(state, "plan_failed", boundary.startedAt, error);
      return { ...boundary.result, status: "failed", failure: infrastructureFailure("planning", reportedError) };
    }
  };

  const execute: typeof CodingRunStateSchema.Node = async (state, runtime) => {
    if (state.status === "failed") return {};
    const boundary = await enterPhase(state, "executing", "execution");
    if (boundary.result.status === "failed") return boundary.result;
    if (state.repoContext === null || state.codingPlan === null || state.baseline === null) {
      const error = new Error("Prepared run state is incomplete");
      const reportedError = await failureAfterRecording(state, "execution_failed", boundary.startedAt, error);
      return { status: "failed", failure: infrastructureFailure("executing", reportedError) };
    }
    try {
      const result = await dependencies.runtime.execute({
        intent: state.userIntent,
        repo: state.repoContext,
        repoInstructions: state.repoInstructions,
        plan: state.codingPlan,
        sessionId: state.sessionId,
        ...(state.humanDecision === null ? {} : { humanDecision: state.humanDecision }),
        ...(state.runtimeContinuation === null ? {} : { runtimeContinuation: state.runtimeContinuation }),
        ...(state.sessionContext === null ? {} : { sessionContext: state.sessionContext }),
        ...(state.projectKnowledge === null ? {} : { projectKnowledge: state.projectKnowledge }),
        signal: runtime.signal ?? new AbortController().signal,
        ...(forwardRuntimeEvent === undefined ? {} : { onEvent: forwardRuntimeEvent }),
      });
      if ("decisionRequest" in result) {
        const decisionRequest = HumanDecisionRequestSchema.parse(result.decisionRequest);
        await recordHumanRequest(state, decisionRequest);
        return {
          ...boundary.result,
          pendingHumanDecision: decisionRequest,
          humanDecision: null,
          runtimeContinuation: result.runtimeContinuation ?? null,
          executionMessage: concise(result.message),
          proposedKnowledge: mergeKnowledge(state.proposedKnowledge, result.proposedKnowledge),
        };
      }
      const changedFiles = await actualChangedFiles(state.baseline);
      await recordTrajectory(state, "execution_completed", {
        startedAt: boundary.startedAt,
        metadata: {
          changedFileCount: changedFiles.length,
          knowledgeProposalCount: result.proposedKnowledge?.length ?? 0,
          knowledgeCategories: [...new Set(result.proposedKnowledge?.map(({ category }) => category) ?? [])],
        },
      });
      return {
        ...boundary.result,
        changedFiles,
        executionMessage: concise(result.message),
        proposedKnowledge: mergeKnowledge(state.proposedKnowledge, result.proposedKnowledge),
        failure: null,
        pendingHumanDecision: null,
        humanDecision: null,
        runtimeContinuation: null,
      };
    } catch (error) {
      const reportedError = await failureAfterRecording(state, "execution_failed", boundary.startedAt, error);
      return { ...boundary.result, status: "failed", failure: infrastructureFailure("executing", reportedError) };
    }
  };

  const verify: typeof CodingRunStateSchema.Node = async (state, runtime) => {
    if (state.status === "failed") return {};
    const boundary = await enterPhase(state, "verifying", "verification");
    if (boundary.result.status === "failed") return boundary.result;
    try {
      const commands = state.verificationCommands.map((command) => ({
        ...command,
        args: [...command.args],
      }));
      const currentVerificationScripts = await verificationScripts(state.repoPath, commands);
      if (
        JSON.stringify(currentVerificationScripts)
        !== JSON.stringify(state.verificationScripts)
      ) {
        const summary = "Verification scripts changed after preparation; refusing to verify modified gates";
        const verification = boundedVerification({
          status: "failed",
          summary,
          commands: [],
        });
        await recordTrajectory(state, "verification_failed");
        await recordTrajectory(state, "verification_completed", {
          startedAt: boundary.startedAt,
        });
        return {
          ...boundary.result,
          verification,
          failure: {
            stage: "verifying",
            message: summary,
            recoverable: false,
          },
        };
      }
      const verification = boundedVerification(
        await runVerification(
          commands,
          state.repoPath,
          runtime.signal ?? new AbortController().signal,
        ),
      );
      if (verification.status !== "passed") {
        await recordTrajectory(state, "verification_failed");
        await recordTrajectory(state, "verification_completed", {
          startedAt: boundary.startedAt,
        });
        return {
          ...boundary.result,
          verification,
          failure: {
            stage: "verifying",
            message: verification.summary,
            recoverable: verification.status === "failed",
            ...(verification.commands.at(-1) === undefined
              ? {}
              : { command: verification.commands.at(-1) }),
          },
        };
      }
      await recordTrajectory(state, "verification_passed");
      await recordTrajectory(state, "verification_completed", {
        startedAt: boundary.startedAt,
      });
      return { ...boundary.result, verification, failure: null };
    } catch (error) {
      const reportedError = await failureAfterRecording(state, "verification_failed", boundary.startedAt, error);
      return { ...boundary.result, status: "failed", failure: infrastructureFailure("verifying", reportedError) };
    }
  };

  const repair: typeof CodingRunStateSchema.Node = async (state, runtime) => {
    const boundary = await enterPhase(state, "repairing", "repair");
    if (boundary.result.status === "failed") return boundary.result;
    if (
      state.repoContext === null ||
      state.codingPlan === null ||
      state.baseline === null ||
      state.failure === null
    ) {
      const error = new Error("Repair state is incomplete");
      const reportedError = await failureAfterRecording(state, "repair_failed", boundary.startedAt, error);
      return { status: "failed", failure: infrastructureFailure("repairing", reportedError) };
    }
    const attempt = state.attempt + 1;
    try {
      const result = await dependencies.runtime.repair({
        intent: state.userIntent,
        repo: state.repoContext,
        repoInstructions: state.repoInstructions,
        plan: state.codingPlan,
        sessionId: state.sessionId,
        attempt,
        failure: state.failure,
        changedFiles: [...state.changedFiles],
        ...(state.humanDecision === null ? {} : { humanDecision: state.humanDecision }),
        ...(state.runtimeContinuation === null ? {} : { runtimeContinuation: state.runtimeContinuation }),
        ...(state.sessionContext === null ? {} : { sessionContext: state.sessionContext }),
        ...(state.projectKnowledge === null ? {} : { projectKnowledge: state.projectKnowledge }),
        signal: runtime.signal ?? new AbortController().signal,
        ...(forwardRuntimeEvent === undefined ? {} : { onEvent: forwardRuntimeEvent }),
      });
      if ("decisionRequest" in result) {
        const decisionRequest = HumanDecisionRequestSchema.parse(result.decisionRequest);
        await recordHumanRequest(state, decisionRequest);
        return {
          ...boundary.result,
          pendingHumanDecision: decisionRequest,
          humanDecision: null,
          runtimeContinuation: result.runtimeContinuation ?? null,
          executionMessage: concise(result.message),
          proposedKnowledge: mergeKnowledge(state.proposedKnowledge, result.proposedKnowledge),
        };
      }
      const changedFiles = await actualChangedFiles(state.baseline);
      await recordTrajectory(state, "repair_completed", {
        startedAt: boundary.startedAt,
        metadata: {
          attempt,
          changedFileCount: changedFiles.length,
          knowledgeProposalCount: result.proposedKnowledge?.length ?? 0,
          knowledgeCategories: [...new Set(result.proposedKnowledge?.map(({ category }) => category) ?? [])],
        },
      });
      return {
        ...boundary.result,
        attempt,
        changedFiles,
        executionMessage: concise(result.message),
        proposedKnowledge: mergeKnowledge(state.proposedKnowledge, result.proposedKnowledge),
        failure: null,
        pendingHumanDecision: null,
        humanDecision: null,
        runtimeContinuation: null,
      };
    } catch (error) {
      const reportedError = await failureAfterRecording(state, "repair_failed", boundary.startedAt, error);
      return { ...boundary.result, status: "failed", failure: infrastructureFailure("repairing", reportedError) };
    }
  };

  const requestHumanInput: typeof CodingRunStateSchema.Node = async (state) => {
    if (state.pendingHumanDecision === null) {
      throw new Error("Human decision state is incomplete");
    }
    const request = HumanDecisionRequestSchema.parse(state.pendingHumanDecision);
    const response = HumanDecisionResponseSchema.forRequest(request).parse(
      interrupt(request),
    );
    await recordTrajectory(state, "human_input_resolved", {
      metadata: {
        requestId: request.id,
        resolution: response.optionId ?? "custom",
      },
    });
    dependencies.eventBus?.emit({
      type: "human_input_resolved",
      requestId: request.id,
      resolution: response.optionId ?? "custom",
    });
    return {
      pendingHumanDecision: null,
      humanDecision: { request, response },
      updatedAt: now().toISOString(),
    };
  };

  const routeAfterRuntime = (state: CodingRunState): "human" | "continue" =>
    state.pendingHumanDecision === null ? "continue" : "human";
  const routeAfterHuman = (state: CodingRunState): "plan" | "execute" | "repair" => {
    switch (state.status) {
      case "planning": return "plan";
      case "executing": return "execute";
      case "repairing": return "repair";
      default: throw new Error(`Cannot route human response from ${state.status} status`);
    }
  };

  const summarize: typeof CodingRunStateSchema.Node = async (state) => {
    const completed = state.failure === null && state.verification?.status === "passed";
    let status: "completed" | "failed" = completed ? "completed" : "failed";
    let summary = completed
      ? `${state.verification?.summary ?? "Run completed"}. ${state.changedFiles.length} file${state.changedFiles.length === 1 ? "" : "s"} changed.`
      : state.failure?.recoverable === true && state.attempt >= state.maxRepairAttempts
        ? `${state.failure.message}; exhausted ${state.maxRepairAttempts} repair attempts.`
        : `Run failed: ${state.failure?.message ?? "unknown failure"}.`;
    if (completed && state.proposedKnowledge.length > 0) {
      knowledgeStore ??= new ProjectKnowledgeStore(state.repoPath);
      await knowledgeStore.append(state.proposedKnowledge);
    }
    try {
      await recordTrajectory(state, "run_completed", {
        metadata: {
          status,
          attempt: state.attempt,
          changedFileCount: state.changedFiles.length,
        },
      });
      await dependencies.registry.updateStatus(state.runId, status, now().toISOString());
    } catch (error) {
      status = "failed";
      summary = `Run failed while finalizing incomplete-run metadata: ${errorMessage(error)}.`;
      return {
        status,
        summary: concise(summary),
        failure: infrastructureFailure("finalizing", error),
        updatedAt: now().toISOString(),
      };
    }
    return { status, summary: concise(summary), updatedAt: now().toISOString() };
  };

  const compiled = new StateGraph(CodingRunStateSchema)
    .addNode("prepare", prepare)
    .addNode("plan", planNode)
    .addNode("execute", execute)
    .addNode("verify", verify)
    .addNode("repair", repair)
    .addNode("human", requestHumanInput)
    .addNode("summarize", summarize)
    .addEdge(START, "prepare")
    .addEdge("prepare", "plan")
    .addConditionalEdges("plan", routeAfterRuntime, { human: "human", continue: "execute" })
    .addConditionalEdges("execute", routeAfterRuntime, { human: "human", continue: "verify" })
    .addConditionalEdges("verify", routeAfterVerification, {
      repair: "repair",
      summarize: "summarize",
    })
    .addConditionalEdges("repair", routeAfterRuntime, { human: "human", continue: "verify" })
    .addConditionalEdges("human", routeAfterHuman, {
      plan: "plan",
      execute: "execute",
      repair: "repair",
    })
    .addEdge("summarize", END)
    .compile({
      ...(options.checkpointer === undefined ? {} : { checkpointer: options.checkpointer }),
      name: "coding-run",
    });

  const config = (threadId: string, signal?: AbortSignal) => ({
    configurable: { thread_id: IdentifierSchema.parse(threadId) },
    ...(signal === undefined ? {} : { signal }),
  });

  return {
    async invoke(input, invokeOptions = {}) {
      const parsed = await CodingRunStateSchema.validateInput(input);
      return compiled.invoke(parsed, config(invokeOptions.threadId ?? input.threadId, invokeOptions.signal));
    },
    getState(threadId) {
      return compiled.getState(config(threadId));
    },
    async resume(threadId, response, resumeOptions = {}) {
      let safeResponse = response;
      if (response !== undefined) {
        const snapshot = await compiled.getState(config(threadId));
        const values = snapshot.values as Partial<CodingRunState>;
        const request = HumanDecisionRequestSchema.safeParse(values.pendingHumanDecision);
        if (!request.success) {
          throw new Error("Cannot resume without a matching pending human request");
        }
        safeResponse = HumanDecisionResponseSchema.forRequest(request.data).parse(response);
      }
      return compiled.invoke(
        safeResponse === undefined ? null : new Command({ resume: safeResponse }),
        config(threadId, resumeOptions.signal),
      );
    },
  };
}
