import { resolve } from "node:path";

import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  AgencyEventSchema,
  PlanSchema,
  type AgencyEvent,
  type FailureContext,
  type Plan,
  type RepoContext,
  type SessionContext,
} from "../domain/index.js";
import { InfrastructureError } from "../process/index.js";
import type {
  CodingEventSink,
  CodingResult,
  CodingRuntime,
  CreatePlanInput,
  CreatePlanResult,
  ExecuteInput,
  RepairInput,
} from "./coding-runtime.js";

const PLANNER_TOOLS = ["read", "grep", "find", "ls", "submit_plan"];
const EXECUTOR_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const MAX_INSTRUCTIONS_CHARS = 6_000;
const MAX_CONTEXT_ITEMS = 6;
const MAX_CONTEXT_ITEM_CHARS = 800;
const MAX_FAILURE_CHARS = 1_500;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_PROVIDER_ERROR_CHARS = 500;

export interface PiSession {
  readonly sessionId: string;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface PiSdkBoundary {
  createModelRuntime(): Promise<ModelRuntime>;
  inMemorySessionManager(cwd: string): SessionManager;
  createSessionManager(cwd: string, sessionDir: string): SessionManager;
  createAgentSession(
    options: CreateAgentSessionOptions,
  ): Promise<{ session: PiSession }>;
}

const defaultSdk: PiSdkBoundary = {
  createModelRuntime: () => ModelRuntime.create(),
  inMemorySessionManager: (cwd) => SessionManager.inMemory(cwd),
  createSessionManager: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir),
  createAgentSession: async (options) => createAgentSession(options),
};

interface ActiveCall {
  toolName: string;
  command?: string;
  path?: string;
  startedAt: number;
}

export interface PiEventState {
  calls: Map<string, ActiveCall>;
  changedFiles: Set<string>;
  finalMessage: string;
  providerError: string | undefined;
}

function sanitizeProviderError(value: string): string {
  return concise(
    value
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/gi, "[REDACTED]")
      .replace(
        /(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "$1[REDACTED]",
      ),
    MAX_PROVIDER_ERROR_CHARS,
  );
}

function recordAssistantMessage(
  message: Extract<AgentSessionEvent, { type: "message_end" }>["message"],
  state: PiEventState,
): void {
  if (message.role !== "assistant") return;
  if (message.stopReason === "error" && message.errorMessage?.trim()) {
    state.providerError = sanitizeProviderError(message.errorMessage);
    return;
  }

  state.providerError = undefined;
  const text = message.content
    .filter((content): content is Extract<typeof content, { type: "text" }> =>
      content.type === "text",
    )
    .map((content) => content.text)
    .join("\n");
  if (text.trim() !== "") state.finalMessage = concise(text);
}

function recordMessages(event: AgentSessionEvent, state: PiEventState): void {
  if (event.type === "message_end") {
    recordAssistantMessage(event.message, state);
    return;
  }
  if (event.type !== "agent_end" || event.willRetry) return;
  for (const message of event.messages) recordAssistantMessage(message, state);
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.trim() !== ""
    ? property.trim()
    : undefined;
}

export function normalizePiEvent(
  event: AgentSessionEvent,
  state: PiEventState,
  now = Date.now(),
): AgencyEvent[] {
  recordMessages(event, state);

  if (event.type === "tool_execution_start") {
    const command = event.toolName === "bash" ? stringProperty(event.args, "command") : undefined;
    const path =
      event.toolName === "edit" || event.toolName === "write"
        ? stringProperty(event.args, "path")
        : undefined;
    state.calls.set(event.toolCallId, {
      toolName: event.toolName,
      startedAt: now,
      ...(command === undefined ? {} : { command }),
      ...(path === undefined ? {} : { path }),
    });
    const events: AgencyEvent[] = [{ type: "tool", tool: event.toolName }];
    if (command !== undefined) events.push({ type: "command_started", command });
    return events;
  }

  if (event.type !== "tool_execution_end") return [];

  const call = state.calls.get(event.toolCallId);
  state.calls.delete(event.toolCallId);
  if (call === undefined) return event.isError
    ? [{ type: "error", message: `${event.toolName} failed` }]
    : [];

  const events: AgencyEvent[] = [];
  if (call.command !== undefined) {
    events.push({
      type: "command_finished",
      command: call.command,
      exitCode: event.isError ? 1 : 0,
      durationMs: Math.max(0, now - call.startedAt),
    });
  }
  if (!event.isError && call.path !== undefined) {
    state.changedFiles.add(call.path);
    events.push({ type: "file_changed", path: call.path });
  }
  if (event.isError) events.push({ type: "error", message: `${event.toolName} failed` });
  return events;
}

function concise(value: string, maxChars = MAX_MESSAGE_CHARS): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function bounded(value: string, maxChars: number): string {
  return concise(value, maxChars);
}

function repositorySummary(repo: RepoContext): string {
  return JSON.stringify({
    rootPath: repo.rootPath,
    branch: repo.currentBranch,
    dirty: repo.isDirty,
    project: repo.project,
  });
}

function sessionSummary(context: SessionContext | undefined): string {
  if (context === undefined) return "None.";
  const turns = context.recentTurns.slice(-MAX_CONTEXT_ITEMS).map((turn) => ({
    role: turn.role,
    content: bounded(turn.content, MAX_CONTEXT_ITEM_CHARS),
  }));
  const runs = context.runSummaries.slice(-MAX_CONTEXT_ITEMS).map((run) => ({
    runId: run.runId,
    status: run.status,
    objective: bounded(run.objective, MAX_CONTEXT_ITEM_CHARS),
    summary: bounded(run.summary, MAX_CONTEXT_ITEM_CHARS),
  }));
  return JSON.stringify({ turns, runs });
}

function repositoryInstructions(input: { repoInstructions?: string }): string {
  return input.repoInstructions === undefined
    ? "Follow repository-local instructions discovered with read-only tools."
    : bounded(input.repoInstructions, MAX_INSTRUCTIONS_CHARS);
}

function plannerPrompt(input: CreatePlanInput): string {
  return [
    "Create a small, executable implementation plan for the stated intent.",
    `Repository: ${repositorySummary(input.repo)}`,
    `Repository instructions: ${repositoryInstructions(input)}`,
    `Intent: ${bounded(input.intent, MAX_INSTRUCTIONS_CHARS)}`,
    `Bounded prior context: ${sessionSummary(input.sessionContext)}`,
    "Inspect only as needed. You have no shell or mutation tools.",
    "Finish by calling submit_plan exactly once with the structured plan; do not print the plan or continue afterward.",
  ].join("\n\n");
}

function executorPrompt(input: ExecuteInput): string {
  return [
    "Implement the validated plan in the repository.",
    `Repository: ${repositorySummary(input.repo)}`,
    `Repository instructions: ${repositoryInstructions(input)}`,
    `Intent: ${bounded(input.intent, MAX_INSTRUCTIONS_CHARS)}`,
    `Validated plan: ${JSON.stringify(PlanSchema.parse(input.plan))}`,
    `Bounded prior context: ${sessionSummary(input.sessionContext)}`,
    "Stay within the plan. Do not commit, stage, push, or open a pull request.",
    "Run only focused self-checks needed while implementing. Stop when the change is ready for independent verification.",
    "End with one concise summary of what changed and any verification caveat; do not include hidden reasoning or raw command output.",
  ].join("\n\n");
}

function failureSummary(failure: FailureContext): string {
  return bounded(
    JSON.stringify({
      stage: failure.stage,
      message: failure.message,
      cause: failure.cause,
      recoverable: failure.recoverable,
      command:
        failure.command === undefined
          ? undefined
          : {
              command: failure.command.command,
              args: failure.command.args,
              exitCode: failure.command.exitCode,
              signal: failure.command.signal,
              timedOut: failure.command.timedOut,
              stderr: bounded(failure.command.stderr, 500),
            },
    }),
    MAX_FAILURE_CHARS,
  );
}

function repairPrompt(input: RepairInput): string {
  return [
    "Repair the existing implementation in this same executor session.",
    `Repository: ${repositorySummary(input.repo)}`,
    `Repository instructions: ${repositoryInstructions(input)}`,
    `Intent: ${bounded(input.intent, MAX_INSTRUCTIONS_CHARS)}`,
    `Validated plan: ${JSON.stringify(PlanSchema.parse(input.plan))}`,
    `Repair attempt ${input.attempt}; bounded failure context: ${failureSummary(input.failure)}`,
    `Bounded prior context: ${sessionSummary(input.sessionContext)}`,
    "Address only the observed failure. Do not commit, stage, push, or open a pull request.",
    "Stop when the repair is ready for independent verification. End with one concise summary, without hidden reasoning or raw output.",
  ].join("\n\n");
}

const planParameters = {
  type: "object",
  additionalProperties: false,
  required: ["plan"],
  properties: {
    plan: {
      type: "object",
      additionalProperties: false,
      required: ["objective", "steps", "verificationStrategy"],
      properties: {
        objective: { type: "string", minLength: 1 },
        assumptions: { type: "array", items: { type: "string", minLength: 1 } },
        steps: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "description"],
            properties: {
              id: { type: "string", minLength: 1 },
              description: { type: "string", minLength: 1 },
            },
          },
        },
        likelyFiles: { type: "array", items: { type: "string", minLength: 1 } },
        verificationStrategy: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as ToolDefinition["parameters"];

function submitPlanTool(onPlan: (value: unknown) => void): ToolDefinition {
  return {
    name: "submit_plan",
    label: "Submit plan",
    description: "Submit the final structured implementation plan and terminate planning.",
    parameters: planParameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      onPlan((params as { plan?: unknown }).plan);
      return {
        content: [{ type: "text", text: "Plan accepted. Stop now." }],
        details: {},
        terminate: true,
      };
    },
  };
}

function infrastructure(
  code:
    | "PI_RUNTIME_INITIALIZATION_FAILED"
    | "PI_SESSION_CREATION_FAILED"
    | "PI_PROVIDER_REQUEST_FAILED"
    | "PI_PLAN_INVALID"
    | "PI_PLAN_MISSING",
  message: string,
  cause?: unknown,
): InfrastructureError {
  if (cause instanceof InfrastructureError) return cause;
  return new InfrastructureError(code, message, cause === undefined ? {} : { cause });
}

function emit(sink: CodingEventSink | undefined, event: AgencyEvent): void {
  sink?.(AgencyEventSchema.parse(event));
}

function abortError(): DOMException {
  return new DOMException("Coding runtime operation aborted", "AbortError");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError();
}

export class PiCodingRuntime implements CodingRuntime {
  readonly #sdk: PiSdkBoundary;
  readonly #modelRuntime: ModelRuntime;
  readonly #executors = new Map<string, PiSession>();
  readonly #activeSessions = new Set<PiSession>();
  #disposed = false;

  private constructor(sdk: PiSdkBoundary, modelRuntime: ModelRuntime) {
    this.#sdk = sdk;
    this.#modelRuntime = modelRuntime;
  }

  static async create(options: { sdk?: PiSdkBoundary } = {}): Promise<PiCodingRuntime> {
    const sdk = options.sdk ?? defaultSdk;
    try {
      return new PiCodingRuntime(sdk, await sdk.createModelRuntime());
    } catch (error) {
      throw infrastructure(
        "PI_RUNTIME_INITIALIZATION_FAILED",
        "Failed to initialize the Pi model runtime",
        error,
      );
    }
  }

  async createPlan(input: CreatePlanInput): Promise<CreatePlanResult> {
    this.#assertUsable();
    assertNotAborted(input.signal);
    let submittedPlan: Plan | undefined;
    let submittedError: InfrastructureError | undefined;
    let planner: PiSession | undefined;
    const tool = submitPlanTool((value) => {
      try {
        submittedPlan = PlanSchema.parse(value);
      } catch (error) {
        submittedError = infrastructure("PI_PLAN_INVALID", "Pi submitted an invalid plan", error);
      }
    });

    try {
      planner = (
        await this.#sdk.createAgentSession({
          cwd: input.repo.rootPath,
          modelRuntime: this.#modelRuntime,
          sessionManager: this.#sdk.inMemorySessionManager(input.repo.rootPath),
          tools: PLANNER_TOOLS,
          customTools: [tool],
        })
      ).session;
    } catch (error) {
      throw infrastructure("PI_SESSION_CREATION_FAILED", "Failed to create Pi planner session", error);
    }

    const state = this.#subscribe(planner, input.onEvent);
    const detachAbort = this.#attachAbort(input.signal, planner);
    this.#activeSessions.add(planner);
    emit(input.onEvent, { type: "phase", phase: "planning" });
    try {
      try {
        await planner.prompt(plannerPrompt(input));
      } catch (error) {
        if (submittedPlan === undefined && submittedError === undefined) {
          assertNotAborted(input.signal);
          throw infrastructure(
            "PI_PROVIDER_REQUEST_FAILED",
            state.eventState.providerError === undefined
              ? "Pi planning request failed"
              : `Pi planning request failed: ${state.eventState.providerError}`,
            error,
          );
        }
      }
      if (submittedError !== undefined) throw submittedError;
      if (submittedPlan === undefined && state.eventState.providerError !== undefined) {
        throw infrastructure(
          "PI_PROVIDER_REQUEST_FAILED",
          `Pi planning request failed: ${state.eventState.providerError}`,
        );
      }
      if (submittedPlan === undefined) {
        throw infrastructure("PI_PLAN_MISSING", "Pi planner stopped without submitting a plan");
      }
      const message = "Plan ready for execution.";
      emit(input.onEvent, { type: "message", content: message });
      return { plan: submittedPlan, message };
    } finally {
      detachAbort();
      state.unsubscribe();
      this.#activeSessions.delete(planner);
      planner.dispose();
    }
  }

  async execute(input: ExecuteInput): Promise<CodingResult> {
    emit(input.onEvent, { type: "phase", phase: "executing" });
    return this.#runExecutor(input, executorPrompt(input));
  }

  async repair(input: RepairInput): Promise<CodingResult> {
    emit(input.onEvent, { type: "phase", phase: "repairing" });
    return this.#runExecutor(input, repairPrompt(input));
  }

  async abort(): Promise<void> {
    const sessions = new Set([...this.#activeSessions, ...this.#executors.values()]);
    await Promise.allSettled([...sessions].map((session) => session.abort()));
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.abort();
    for (const session of this.#executors.values()) session.dispose();
    this.#executors.clear();
    this.#activeSessions.clear();
  }

  async #runExecutor(input: ExecuteInput, prompt: string): Promise<CodingResult> {
    this.#assertUsable();
    assertNotAborted(input.signal);
    const session = await this.#executor(input.repo);
    const state = this.#subscribe(session, input.onEvent);
    const detachAbort = this.#attachAbort(input.signal, session);
    this.#activeSessions.add(session);
    try {
      await session.prompt(prompt);
      assertNotAborted(input.signal);
      if (state.eventState.providerError !== undefined) {
        throw infrastructure(
          "PI_PROVIDER_REQUEST_FAILED",
          `Pi execution request failed: ${state.eventState.providerError}`,
        );
      }
      const message = state.eventState.finalMessage || "Implementation is ready for independent verification.";
      emit(input.onEvent, { type: "message", content: message });
      return {
        message,
        changedFiles: [...state.eventState.changedFiles],
        sessionId: session.sessionId,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw infrastructure("PI_PROVIDER_REQUEST_FAILED", "Pi execution request failed", error);
    } finally {
      detachAbort();
      state.unsubscribe();
      this.#activeSessions.delete(session);
    }
  }

  async #executor(repo: RepoContext): Promise<PiSession> {
    const existing = this.#executors.get(repo.rootPath);
    if (existing !== undefined) return existing;
    try {
      const sessionDir = resolve(repo.rootPath, ".devagency/pi-sessions");
      const { session } = await this.#sdk.createAgentSession({
        cwd: repo.rootPath,
        modelRuntime: this.#modelRuntime,
        sessionManager: this.#sdk.createSessionManager(repo.rootPath, sessionDir),
        tools: EXECUTOR_TOOLS,
      });
      this.#executors.set(repo.rootPath, session);
      return session;
    } catch (error) {
      throw infrastructure("PI_SESSION_CREATION_FAILED", "Failed to create Pi executor session", error);
    }
  }

  #subscribe(session: PiSession, sink: CodingEventSink | undefined): {
    eventState: PiEventState;
    unsubscribe: () => void;
  } {
    const eventState: PiEventState = {
      calls: new Map(),
      changedFiles: new Set(),
      finalMessage: "",
      providerError: undefined,
    };
    const unsubscribe = session.subscribe((event) => {
      for (const normalized of normalizePiEvent(event, eventState)) emit(sink, normalized);
    });
    return { eventState, unsubscribe };
  }

  #attachAbort(signal: AbortSignal | undefined, session: PiSession): () => void {
    if (signal === undefined) return () => {};
    const abort = () => {
      void session.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw infrastructure("PI_SESSION_CREATION_FAILED", "Pi coding runtime is disposed");
    }
  }
}
