import {
  END,
  START,
  StateGraph,
  StateSchema,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { z } from "zod";

import type { CodingRuntime } from "../coding/index.js";
import {
  FailureContextSchema,
  PlanSchema,
  RepoContextSchema,
  SessionContextSchema,
  type AgencyPhase,
  type FailureContext,
  type VerificationResult,
} from "../domain/index.js";
import type { EventBus } from "../events/index.js";
import type {
  IncompleteRunEntry,
  IncompleteRunRegistry,
} from "../persistence/index.js";
import {
  VerificationRunner,
  detectNodeVerificationCommands,
  InfrastructureError,
  type VerificationCommand,
} from "../process/index.js";
import {
  captureGitBaseline,
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
  porcelain: TextSchema,
  paths: z
    .record(
      z.string(),
      z.strictObject({ tracked: z.boolean(), identity: z.string().nullable() }),
    )
    .refine((paths) => Object.keys(paths).length <= MAX_BASELINE_PATHS),
});

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
  codingPlan: BoundedPlanSchema.nullable().default(null),
  baseline: GitBaselineSchema.nullable().default(null),
  attempt: z.number().int().nonnegative().max(20).default(0),
  maxRepairAttempts: z.number().int().positive().max(20).default(2),
  changedFiles: z.array(z.string().trim().min(1)).max(MAX_CHANGED_FILES).default([]),
  verification: BoundedVerificationSchema.nullable().default(null),
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
  registry: IncompleteRunRegistryBoundary | IncompleteRunRegistry;
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
  resume(threadId: string, options?: { signal?: AbortSignal }): Promise<CodingRunState>;
}

type PhaseStatus = Extract<
  CodingRunState["status"],
  "preparing" | "planning" | "executing" | "verifying" | "repairing"
>;

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

  async function actualChangedFiles(baseline: GitBaseline): Promise<string[]> {
    return (await changedFilesSince(baseline))
      .map(({ path }) => path)
      .filter((path) => !isInternalMetadataPath(path))
      .slice(0, MAX_CHANGED_FILES);
  }

  async function enterPhase(
    state: CodingRunState,
    status: PhaseStatus,
  ): Promise<{ status: PhaseStatus; updatedAt: string } | { status: "failed"; failure: FailureContext; updatedAt: string }> {
    const updatedAt = now().toISOString();
    try {
      dependencies.eventBus?.emit({ type: "phase", phase: status as AgencyPhase });
      await dependencies.registry.updateStatus(state.runId, status, updatedAt);
      return { status, updatedAt };
    } catch (error) {
      return {
        status: "failed",
        failure: infrastructureFailure(status, error),
        updatedAt,
      };
    }
  }

  const prepare: typeof CodingRunStateSchema.Node = async (state) => {
    const createdAt = state.createdAt ?? now().toISOString();
    try {
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
      const inspection = await inspect(state.repoPath);
      const repoInstructions = await loadInstructions(
        inspection.rootPath,
        inspection.instructionFiles,
      );
      const baseline = await captureBaseline(inspection.rootPath);
      return {
        status: "preparing",
        repoPath: inspection.rootPath,
        repoContext: repositoryContext(inspection),
        repoInstructions,
        baseline,
        createdAt,
        updatedAt: createdAt,
      };
    } catch (error) {
      return {
        status: "failed",
        failure: infrastructureFailure("preparing", error),
        createdAt,
        updatedAt: now().toISOString(),
      };
    }
  };

  const planNode: typeof CodingRunStateSchema.Node = async (state, runtime) => {
    if (state.status === "failed") return {};
    const boundary = await enterPhase(state, "planning");
    if (boundary.status === "failed") return boundary;
    if (state.repoContext === null) {
      return { status: "failed", failure: infrastructureFailure("planning", new Error("Repository context is unavailable")) };
    }
    try {
      const result = await dependencies.runtime.createPlan({
        intent: state.userIntent,
        repo: state.repoContext,
        repoInstructions: state.repoInstructions,
        ...(state.sessionContext === null ? {} : { sessionContext: state.sessionContext }),
        signal: runtime.signal ?? new AbortController().signal,
      });
      return { ...boundary, codingPlan: BoundedPlanSchema.parse(result.plan), executionMessage: concise(result.message) };
    } catch (error) {
      return { ...boundary, status: "failed", failure: infrastructureFailure("planning", error) };
    }
  };

  const execute: typeof CodingRunStateSchema.Node = async (state, runtime) => {
    if (state.status === "failed") return {};
    const boundary = await enterPhase(state, "executing");
    if (boundary.status === "failed") return boundary;
    if (state.repoContext === null || state.codingPlan === null || state.baseline === null) {
      return { status: "failed", failure: infrastructureFailure("executing", new Error("Prepared run state is incomplete")) };
    }
    try {
      const result = await dependencies.runtime.execute({
        intent: state.userIntent,
        repo: state.repoContext,
        repoInstructions: state.repoInstructions,
        plan: state.codingPlan,
        ...(state.sessionContext === null ? {} : { sessionContext: state.sessionContext }),
        signal: runtime.signal ?? new AbortController().signal,
      });
      return {
        ...boundary,
        changedFiles: await actualChangedFiles(state.baseline),
        executionMessage: concise(result.message),
        failure: null,
      };
    } catch (error) {
      return { ...boundary, status: "failed", failure: infrastructureFailure("executing", error) };
    }
  };

  const verify: typeof CodingRunStateSchema.Node = async (state, runtime) => {
    if (state.status === "failed") return {};
    const boundary = await enterPhase(state, "verifying");
    if (boundary.status === "failed") return boundary;
    try {
      const commands = await detectCommands(state.repoPath);
      const verification = boundedVerification(
        await runVerification(
          commands,
          state.repoPath,
          runtime.signal ?? new AbortController().signal,
        ),
      );
      if (verification.status === "failed") {
        return {
          ...boundary,
          verification,
          failure: {
            stage: "verifying",
            message: verification.summary,
            recoverable: true,
            ...(verification.commands.at(-1) === undefined
              ? {}
              : { command: verification.commands.at(-1) }),
          },
        };
      }
      return { ...boundary, verification, failure: null };
    } catch (error) {
      return { ...boundary, status: "failed", failure: infrastructureFailure("verifying", error) };
    }
  };

  const repair: typeof CodingRunStateSchema.Node = async (state, runtime) => {
    const boundary = await enterPhase(state, "repairing");
    if (boundary.status === "failed") return boundary;
    if (
      state.repoContext === null ||
      state.codingPlan === null ||
      state.baseline === null ||
      state.failure === null
    ) {
      return { status: "failed", failure: infrastructureFailure("repairing", new Error("Repair state is incomplete")) };
    }
    const attempt = state.attempt + 1;
    try {
      const result = await dependencies.runtime.repair({
        intent: state.userIntent,
        repo: state.repoContext,
        repoInstructions: state.repoInstructions,
        plan: state.codingPlan,
        attempt,
        failure: state.failure,
        ...(state.sessionContext === null ? {} : { sessionContext: state.sessionContext }),
        signal: runtime.signal ?? new AbortController().signal,
      });
      return {
        ...boundary,
        attempt,
        changedFiles: await actualChangedFiles(state.baseline),
        executionMessage: concise(result.message),
        failure: null,
      };
    } catch (error) {
      return { ...boundary, attempt, status: "failed", failure: infrastructureFailure("repairing", error) };
    }
  };

  const summarize: typeof CodingRunStateSchema.Node = async (state) => {
    const completed = state.failure === null && state.verification?.status !== "failed";
    let status: "completed" | "failed" = completed ? "completed" : "failed";
    let summary = completed
      ? `${state.verification?.summary ?? "Run completed"}. ${state.changedFiles.length} file${state.changedFiles.length === 1 ? "" : "s"} changed.`
      : state.failure?.recoverable === true && state.attempt >= state.maxRepairAttempts
        ? `${state.failure.message}; exhausted ${state.maxRepairAttempts} repair attempts.`
        : `Run failed: ${state.failure?.message ?? "unknown failure"}.`;
    try {
      await dependencies.registry.updateStatus(state.runId, status, now().toISOString());
    } catch (error) {
      status = "failed";
      summary = `Run failed while finalizing incomplete-run metadata: ${errorMessage(error)}.`;
      return {
        status,
        summary: concise(summary),
        failure: infrastructureFailure("verifying", error),
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
    .addNode("summarize", summarize)
    .addEdge(START, "prepare")
    .addEdge("prepare", "plan")
    .addEdge("plan", "execute")
    .addEdge("execute", "verify")
    .addConditionalEdges("verify", routeAfterVerification, {
      repair: "repair",
      summarize: "summarize",
    })
    .addEdge("repair", "verify")
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
    resume(threadId, resumeOptions = {}) {
      return compiled.invoke(null, config(threadId, resumeOptions.signal));
    },
  };
}
