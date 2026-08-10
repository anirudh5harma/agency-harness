import { resolve } from "node:path";

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createBashToolDefinition,
  createAgentSession,
  getAgentDir,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ResourceLoader,
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
const PI_NO_API_KEY_ERROR = "No API key found for the selected model.";

export interface PiSession {
  readonly sessionId: string;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

type PiBashToolDefinition = ReturnType<typeof createBashToolDefinition>;

export interface PiSdkBoundary {
  createModelRuntime(): Promise<ModelRuntime>;
  inMemorySessionManager(cwd: string): SessionManager;
  createSessionManager(cwd: string, sessionDir: string): SessionManager;
  createResourceLoader(cwd: string): Promise<ResourceLoader>;
  createBashTool(cwd: string): PiBashToolDefinition;
  createAgentSession(
    options: CreateAgentSessionOptions,
  ): Promise<{ session: PiSession }>;
}

export async function createSafeResourceLoader(cwd: string): Promise<ResourceLoader> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    // Extensions are executable code. Agency never loads them from the target project.
    noExtensions: true,
    // Prompts already carry Agency's explicitly bounded repository instructions.
    noContextFiles: true,
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  return loader;
}

const defaultSdk: PiSdkBoundary = {
  createModelRuntime: () => ModelRuntime.create(),
  inMemorySessionManager: (cwd) => SessionManager.inMemory(cwd),
  createSessionManager: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir),
  createResourceLoader: createSafeResourceLoader,
  createBashTool: (cwd) => createBashToolDefinition(cwd),
  createAgentSession,
};

const SAFE_GIT_COMMANDS = new Set([
  "cat-file", "describe", "diff", "for-each-ref", "log", "ls-files", "ls-tree",
  "merge-base", "name-rev", "rev-list", "rev-parse", "show", "show-ref", "status",
]);
const CONCEALING_SHELL_COMMANDS = new Set([
  "alias", "eval", "source", "bash", "dash", "ksh", "sh", "zsh",
]);

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  const finish = () => {
    if (word !== "") words.push(word);
    word = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\\" && quote !== "'") {
      if (index + 1 < command.length) word += command[++index];
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === undefined) quote = character;
      else if (quote === character) quote = undefined;
      else word += character;
      continue;
    }
    if (/\s/.test(character) || ";|&()<>`".includes(character)) {
      finish();
      continue;
    }
    word += character;
  }
  finish();
  return words;
}

function basename(command: string): string {
  return command.slice(command.lastIndexOf("/") + 1).toLowerCase();
}

function isUnsafeGitInvocation(words: string[], gitIndex: number): boolean {
  let index = gitIndex + 1;
  while (index < words.length && words[index]!.startsWith("-")) {
    const option = words[index]!.toLowerCase();
    // Per-invocation configuration can redefine otherwise safe commands.
    if (words[index] === "-c" || option.startsWith("-c=")) return true;
    index += ["-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]
      .includes(words[index]!) ? 2 : 1;
  }
  const subcommand = words[index]?.toLowerCase();
  return subcommand === undefined || !SAFE_GIT_COMMANDS.has(subcommand);
}

function assertAllowedBash(command: string): void {
  const words = shellWords(command);
  const lower = words.map((word) => word.toLowerCase());
  const hasUnsafeGit = words.some(
    (word, index) => basename(word) === "git" && isUnsafeGitInvocation(words, index),
  );
  const hasPrCreation = lower.some((word, index) => {
    const remaining = lower.slice(index + 1);
    const hasOrderedWords = (first: string, second: string) => {
      const firstIndex = remaining.indexOf(first);
      return firstIndex >= 0 && remaining.indexOf(second, firstIndex + 1) >= 0;
    };
    return (basename(word) === "gh" && hasOrderedWords("pr", "create")) ||
      (basename(word) === "glab" && hasOrderedWords("mr", "create")) ||
      (basename(word) === "hub" && remaining.includes("pull-request"));
  });
  const hasConcealedInvocation = words.some((word) => {
    const name = basename(word);
    return CONCEALING_SHELL_COMMANDS.has(name) ||
      (/^(?:\.\.\/|\.\/|\/)/.test(word) && /(?:\.(?:ba)?sh|\/[^/]+)$/.test(word));
  });
  if (hasUnsafeGit || hasPrCreation || hasConcealedInvocation) {
    throw new Error(
      "Agency policy blocks Git staging, commits, pushes, and pull-request creation",
    );
  }
}

function protectedBashTool(delegate: PiBashToolDefinition): PiBashToolDefinition {
  return {
    ...delegate,
    async execute(toolCallId, params, signal, onUpdate, context) {
      assertAllowedBash(stringProperty(params, "command") ?? "");
      return delegate.execute(toolCallId, params, signal, onUpdate, context);
    },
  };
}

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

function redactSensitiveText(value: string): string {
  return value
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/gi, "[REDACTED]")
      .replace(
        /(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
        "$1[REDACTED]",
      );
}

function sanitizeProviderError(value: string): string {
  return concise(redactSensitiveText(value), MAX_PROVIDER_ERROR_CHARS);
}

function knownPublicPiError(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message.trimStart().startsWith(PI_NO_API_KEY_ERROR)) {
    return undefined;
  }
  return sanitizeProviderError(PI_NO_API_KEY_ERROR);
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
  if (text.trim() !== "") state.finalMessage = concise(redactSensitiveText(text));
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
    const rawCommand = event.toolName === "bash" ? stringProperty(event.args, "command") : undefined;
    const command = rawCommand === undefined ? undefined : redactSensitiveText(rawCommand);
    const rawPath =
      event.toolName === "edit" || event.toolName === "write"
        ? stringProperty(event.args, "path")
        : undefined;
    const path = rawPath === undefined ? undefined : redactSensitiveText(rawPath);
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
    content: concise(turn.content, MAX_CONTEXT_ITEM_CHARS),
  }));
  const runs = context.runSummaries.slice(-MAX_CONTEXT_ITEMS).map((run) => ({
    runId: run.runId,
    status: run.status,
    objective: concise(run.objective, MAX_CONTEXT_ITEM_CHARS),
    summary: concise(run.summary, MAX_CONTEXT_ITEM_CHARS),
  }));
  return JSON.stringify({ turns, runs });
}

function repositoryInstructions(input: { repoInstructions?: string }): string {
  return input.repoInstructions === undefined
    ? "Follow repository-local instructions discovered with read-only tools."
    : concise(input.repoInstructions, MAX_INSTRUCTIONS_CHARS);
}

function plannerPrompt(input: CreatePlanInput): string {
  return [
    "Create a small, executable implementation plan for the stated intent.",
    `Repository: ${repositorySummary(input.repo)}`,
    `Repository instructions: ${repositoryInstructions(input)}`,
    `Intent: ${concise(input.intent, MAX_INSTRUCTIONS_CHARS)}`,
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
    `Intent: ${concise(input.intent, MAX_INSTRUCTIONS_CHARS)}`,
    `Validated plan: ${JSON.stringify(PlanSchema.parse(input.plan))}`,
    `Bounded prior context: ${sessionSummary(input.sessionContext)}`,
    "Stay within the plan. Do not commit, stage, push, or open a pull request.",
    "Run only focused self-checks needed while implementing. Stop when the change is ready for independent verification.",
    "End with one concise summary of what changed and any verification caveat; do not include hidden reasoning or raw command output.",
  ].join("\n\n");
}

function failureSummary(failure: FailureContext, changedFiles: string[]): string {
  return concise(
    JSON.stringify({
      stage: failure.stage,
      message: failure.message,
      cause: failure.cause,
      recoverable: failure.recoverable,
      changedFiles: changedFiles.slice(0, 200),
      command:
        failure.command === undefined
          ? undefined
          : {
              command: failure.command.command,
              args: failure.command.args,
              exitCode: failure.command.exitCode,
              signal: failure.command.signal,
              timedOut: failure.command.timedOut,
              stdout: concise(failure.command.stdout, 500),
              stderr: concise(failure.command.stderr, 500),
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
    `Intent: ${concise(input.intent, MAX_INSTRUCTIONS_CHARS)}`,
    `Validated plan: ${JSON.stringify(PlanSchema.parse(input.plan))}`,
    `Repair attempt ${input.attempt}; bounded failure context: ${failureSummary(input.failure, input.changedFiles)}`,
    `Bounded prior context: ${sessionSummary(input.sessionContext)}`,
    "Diagnose the failure before editing, then address only the observed failure.",
    "Never weaken or delete tests, lint rules, typecheck settings, configuration, or scripts to make verification pass.",
    "Do not commit, stage, push, or open a pull request.",
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
  const sanitized = (() => {
    switch (event.type) {
      case "tool": return {
        ...event,
        tool: redactSensitiveText(event.tool),
        ...(event.detail === undefined ? {} : { detail: redactSensitiveText(event.detail) }),
      };
      case "file_changed": return { ...event, path: redactSensitiveText(event.path) };
      case "command_started":
      case "command_finished": return { ...event, command: redactSensitiveText(event.command) };
      case "message": return { ...event, content: redactSensitiveText(event.content) };
      case "error": return { ...event, message: redactSensitiveText(event.message) };
      default: return event;
    }
  })();
  sink?.(AgencyEventSchema.parse(sanitized));
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
          resourceLoader: await this.#sdk.createResourceLoader(input.repo.rootPath),
          tools: PLANNER_TOOLS,
          customTools: [tool],
        })
      ).session;
    } catch (error) {
      throw infrastructure("PI_SESSION_CREATION_FAILED", "Failed to create Pi planner session", error);
    }

    this.#activeSessions.add(planner);
    const state = this.#subscribe(planner, input.onEvent);
    const abortState = this.#attachAbort(input.signal, planner);
    try {
      assertNotAborted(input.signal);
      emit(input.onEvent, { type: "phase", phase: "planning" });
      try {
        await planner.prompt(plannerPrompt(input));
      } catch (error) {
        if (submittedPlan === undefined && submittedError === undefined) {
          assertNotAborted(input.signal);
          const providerError = state.eventState.providerError ?? knownPublicPiError(error);
          throw infrastructure(
            "PI_PROVIDER_REQUEST_FAILED",
            providerError === undefined
              ? "Pi planning request failed"
              : `Pi planning request failed: ${providerError}`,
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
      abortState.detach();
      await abortState.completion();
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
    const executors = new Set(this.#executors.values());
    // An aborted Pi session is not safe to reuse for a later Agency turn.
    this.#executors.clear();
    await Promise.allSettled([...sessions].map((session) => session.abort()));
    for (const session of executors) session.dispose();
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
    const session = await this.#executor(input.repo, input.sessionId, input.signal);
    const state = this.#subscribe(session, input.onEvent);
    this.#activeSessions.add(session);
    const executorKey = this.#executorKey(input.repo, input.sessionId);
    const abortState = this.#attachAbort(input.signal, session, () => {
      if (this.#executors.get(executorKey) === session) this.#executors.delete(executorKey);
    });
    try {
      assertNotAborted(input.signal);
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
      abortState.detach();
      await abortState.completion();
      if (input.signal?.aborted === true) session.dispose();
      state.unsubscribe();
      this.#activeSessions.delete(session);
    }
  }

  async #executor(
    repo: RepoContext,
    agencySessionId: string,
    signal: AbortSignal | undefined,
  ): Promise<PiSession> {
    const executorKey = this.#executorKey(repo, agencySessionId);
    const existing = this.#executors.get(executorKey);
    if (existing !== undefined) return existing;
    try {
      const sessionDir = resolve(repo.rootPath, ".devagency/pi-sessions");
      const { session } = await this.#sdk.createAgentSession({
        cwd: repo.rootPath,
        modelRuntime: this.#modelRuntime,
        sessionManager: this.#sdk.createSessionManager(repo.rootPath, sessionDir),
        resourceLoader: await this.#sdk.createResourceLoader(repo.rootPath),
        tools: EXECUTOR_TOOLS,
        customTools: [
          protectedBashTool(this.#sdk.createBashTool(repo.rootPath)) as unknown as ToolDefinition,
        ],
      });
      if (signal?.aborted === true) {
        await session.abort();
        session.dispose();
        throw abortError();
      }
      this.#executors.set(executorKey, session);
      return session;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
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

  #attachAbort(
    signal: AbortSignal | undefined,
    session: PiSession,
    onAbort: () => void = () => {},
  ): { detach: () => void; completion: () => Promise<void> } {
    let completion: Promise<void> | undefined;
    if (signal === undefined) return { detach: () => {}, completion: async () => {} };
    const abort = () => {
      onAbort();
      completion ??= session.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return {
      detach: () => signal.removeEventListener("abort", abort),
      completion: async () => { await completion?.catch(() => {}); },
    };
  }

  #executorKey(repo: RepoContext, agencySessionId: string): string {
    return `${repo.rootPath}\0${agencySessionId}`;
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw infrastructure("PI_SESSION_CREATION_FAILED", "Pi coding runtime is disposed");
    }
  }
}
