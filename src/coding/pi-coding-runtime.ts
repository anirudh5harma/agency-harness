import { basename as pathBasename, resolve, sep } from "node:path";

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createBashToolDefinition,
  createAgentSession,
  getAgentDir,
  type AgentSessionEvent,
  type CreateAgentSessionResult,
  type CreateAgentSessionOptions,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  AgencyEventSchema,
  HumanDecisionRequestSchema,
  PlanSchema,
  ProjectKnowledgeEntrySchema,
  redactSecrets,
  renderProjectKnowledge,
  type AgencyEvent,
  type FailureContext,
  type HumanDecisionRequest,
  type Plan,
  type ProjectKnowledgeEntry,
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
  RuntimeContinuation,
} from "./coding-runtime.js";

const PLANNER_TOOLS = ["read", "grep", "find", "ls", "submit_plan", "request_human_input"];
const EXECUTOR_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "request_human_input"];
const MAX_INSTRUCTIONS_CHARS = 6_000;
const MAX_CONTEXT_ITEMS = 6;
const MAX_CONTEXT_ITEM_CHARS = 800;
const MAX_FAILURE_CHARS = 1_500;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_PROVIDER_ERROR_CHARS = 500;
const PI_NO_API_KEY_ERROR = "No API key found for the selected model.";

export interface PiSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly agent?: CreateAgentSessionResult["session"]["agent"];
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

const exclusiveHumanRequestAgents = new WeakSet<NonNullable<PiSession["agent"]>>();

function enforceExclusiveHumanRequest(session: PiSession): void {
  if (session.agent === undefined) return;
  if (exclusiveHumanRequestAgents.has(session.agent)) return;
  const previous = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    const hasHumanRequest = context.assistantMessage.content.some(
      (content) => content.type === "toolCall" && content.name === "request_human_input",
    );
    if (hasHumanRequest && context.toolCall.name !== "request_human_input") {
      return {
        block: true,
        reason: "A human-input request must be the only tool in its assistant tool batch",
        terminate: true,
      };
    }
    return previous?.(context, signal);
  };
  exclusiveHumanRequestAgents.add(session.agent);
}

function sessionDirectory(repo: RepoContext, role: RuntimeContinuation["role"]): string {
  return resolve(repo.rootPath, ".devagency", "pi-sessions", role);
}

function continuationPath(repo: RepoContext, continuation: RuntimeContinuation): string {
  if (
    continuation.sessionFile.length > 255 ||
    continuation.sessionFile !== pathBasename(continuation.sessionFile) ||
    !/^[A-Za-z0-9._-]+\.jsonl$/u.test(continuation.sessionFile)
  ) {
    throw new Error("Invalid Pi runtime continuation identity");
  }
  const directory = sessionDirectory(repo, continuation.role);
  const path = resolve(directory, continuation.sessionFile);
  if (!path.startsWith(`${directory}${sep}`)) throw new Error("Invalid Pi runtime continuation path");
  return path;
}

function runtimeContinuation(session: PiSession, role: RuntimeContinuation["role"]): RuntimeContinuation {
  if (session.sessionFile === undefined) {
    throw new Error("Persistent Pi session did not expose a continuation file");
  }
  return { role, sessionFile: pathBasename(session.sessionFile) };
}

type PiBashToolDefinition = ReturnType<typeof createBashToolDefinition>;

export interface PiSdkBoundary {
  createModelRuntime(): Promise<ModelRuntime>;
  createSessionManager(cwd: string, sessionDir: string): SessionManager;
  openSessionManager(cwd: string, sessionDir: string, sessionFile: string): SessionManager;
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
  createSessionManager: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir),
  openSessionManager: (cwd, sessionDir, sessionFile) =>
    SessionManager.open(sessionFile, sessionDir, cwd),
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

function normalizedAction(command: string): string {
  return command.replace(/\s+/gu, " ").trim();
}

function isRecursiveRm(words: readonly string[]): boolean {
  return words.some((word, index) => {
    if (basename(word) !== "rm") return false;
    return words.slice(index + 1).some((argument) => {
      const option = argument.toLowerCase();
      if (option === "--recursive" || option.startsWith("--recursive=")) return true;
      return /^-[^-]*r[^-]*$/u.test(option);
    });
  });
}

function isConsequentialShell(command: string, words = shellWords(command)): boolean {
  const normalized = normalizedAction(command).toLowerCase();
  return isRecursiveRm(words) ||
    /(?:^|\s)(?:drop\s+(?:database|table)|truncate\s+table)(?:\s|$)/u.test(normalized) ||
    /(?:prisma|knex|sequelize|typeorm|rails|rake|django-admin|alembic)[^\n]*(?:migrate|migration)/u.test(normalized) ||
    /(?:npm|pnpm|yarn|bun)\s+(?:remove|uninstall|install|add|update|up)(?:\s|$)/u.test(normalized);
}

function assertAllowedBash(command: string, consumeApproval: (action: string) => boolean): void {
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
  const action = normalizedAction(command);
  if (isConsequentialShell(action, words) && !consumeApproval(action)) {
    throw new Error(
      "Agency policy requires explicit one-shot approval for this exact consequential command",
    );
  }
}

function protectedBashTool(
  delegate: PiBashToolDefinition,
  consumeApproval: (action: string) => boolean,
): PiBashToolDefinition {
  return {
    ...delegate,
    async execute(toolCallId, params, signal, onUpdate, context) {
      assertAllowedBash(stringProperty(params, "command") ?? "", consumeApproval);
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
  assistantStream?: IncrementalSecretRedactor;
  assistantTextContentIndex?: number;
  finalMessageStreamed?: boolean;
}

const MAX_STREAM_REDACTOR_PENDING = 64;
const SENSITIVE_ASSIGNMENT_NAMES = [
  "apikey",
  "accesstoken",
  "refreshtoken",
  "token",
  "password",
] as const;
const SENSITIVE_PREFIX_PATTERN = /\b(?:Bearer\s+|sk-|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password)\b\s*[:=]\s*)/iu;

function uncertainSensitiveSuffixStart(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0 && /[A-Za-z0-9_]/u.test(value[index - 1] ?? "")) continue;
    const suffix = value.slice(index).toLowerCase();
    if ("bearer".startsWith(suffix.trimEnd()) || "sk-".startsWith(suffix)) return index;

    const operator = suffix.search(/[:=]/u);
    const rawName = operator === -1 ? suffix.trimEnd() : suffix.slice(0, operator).trimEnd();
    const name = rawName.replace(/[ _-]/gu, "");
    if (name === "") continue;
    if (!SENSITIVE_ASSIGNMENT_NAMES.some((candidate) => candidate.startsWith(name))) continue;
    if (operator === -1 || /^[:=]\s*$/u.test(suffix.slice(operator))) return index;
  }
  return value.length;
}

/**
 * Redacts streaming secrets without releasing an uncertain prefix or active value.
 * Pending state is capped; active secret bytes are discarded rather than buffered.
 */
class IncrementalSecretRedactor {
  #pending = "";
  #sensitivePrefix: string | null = null;
  #quote: "\"" | "'" | null | undefined;
  #awaitingValue = false;
  #escaped = false;

  push(chunk: string, done = false): string {
    let output = "";
    let remaining = chunk;
    while (remaining !== "") {
      if (this.#sensitivePrefix !== null) {
        const consumed = this.#consumeSensitive(remaining);
        output += consumed.output;
        remaining = consumed.remaining;
        if (consumed.waiting) break;
        continue;
      }

      this.#pending += remaining;
      remaining = "";
      const match = SENSITIVE_PREFIX_PATTERN.exec(this.#pending);
      if (match !== null) {
        output += redactSecrets(this.#pending.slice(0, match.index));
        this.#sensitivePrefix = match[0].toLowerCase().startsWith("sk-") ? "" : match[0];
        remaining = this.#pending.slice(match.index + match[0].length);
        this.#pending = "";
        this.#quote = undefined;
        this.#awaitingValue = true;
        this.#escaped = false;
        continue;
      }

      const uncertainAt = uncertainSensitiveSuffixStart(this.#pending);
      output += redactSecrets(this.#pending.slice(0, uncertainAt));
      this.#pending = this.#pending.slice(uncertainAt);
      if (this.#pending.length > MAX_STREAM_REDACTOR_PENDING) {
        this.#pending = "";
        this.#sensitivePrefix = "";
        this.#quote = null;
        this.#awaitingValue = false;
      }
    }

    if (!done) return output;
    if (this.#sensitivePrefix !== null) {
      output += `${this.#sensitivePrefix}[REDACTED]`;
    } else {
      output += redactSecrets(this.#pending);
    }
    this.#pending = "";
    this.#sensitivePrefix = null;
    this.#quote = undefined;
    this.#awaitingValue = false;
    this.#escaped = false;
    return output;
  }

  #consumeSensitive(value: string): { output: string; remaining: string; waiting: boolean } {
    let input = value;
    if (this.#awaitingValue) {
      let valueAt = 0;
      while (valueAt < input.length && /\s/u.test(input[valueAt] ?? "")) valueAt += 1;
      input = input.slice(valueAt);
      if (input === "") return { output: "", remaining: "", waiting: true };
      this.#awaitingValue = false;
    }
    if (this.#quote === undefined) {
      if (input === "") return { output: "", remaining: "", waiting: true };
      const first = input[0];
      if (first === "\"" || first === "'") {
        this.#quote = first;
        input = input.slice(1);
        this.#escaped = false;
      } else {
        this.#quote = null;
      }
    }

    let delimiterAt = -1;
    if (this.#quote === null) {
      delimiterAt = input.search(/[\s,;&]/u);
    } else {
      for (let index = 0; index < input.length; index += 1) {
        const character = input[index] ?? "";
        if (this.#escaped) {
          this.#escaped = false;
        } else if (character === "\\") {
          this.#escaped = true;
        } else if (character === this.#quote) {
          delimiterAt = index;
          break;
        }
      }
    }
    if (delimiterAt === -1) return { output: "", remaining: "", waiting: true };

    const delimiter = input[delimiterAt] ?? "";
    const remaining = input.slice(delimiterAt + 1);
    const output = `${this.#sensitivePrefix ?? ""}[REDACTED]${this.#quote === null ? delimiter : ""}`;
    this.#sensitivePrefix = null;
    this.#quote = undefined;
    this.#awaitingValue = false;
    this.#escaped = false;
    return { output, remaining, waiting: false };
  }
}

function assistantDeltaEvents(delta: string, done: boolean): AgencyEvent[] {
  if (delta === "") {
    return done ? [{ type: "assistant_text_delta", delta: "", done: true }] : [];
  }
  const events: AgencyEvent[] = [];
  let offset = 0;
  while (offset < delta.length) {
    let end = Math.min(offset + 65_536, delta.length);
    const finalCodeUnit = delta.charCodeAt(end - 1);
    if (end < delta.length && finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
    const slice = delta.slice(offset, end);
    events.push({
      type: "assistant_text_delta",
      delta: slice,
      done: done && end === delta.length,
    });
    offset = end;
  }
  return events;
}

function sanitizeProviderError(value: string): string {
  return concise(redactSecrets(value), MAX_PROVIDER_ERROR_CHARS);
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
): boolean {
  if (message.role !== "assistant") return false;
  if (message.stopReason === "error" && message.errorMessage?.trim()) {
    state.providerError = sanitizeProviderError(message.errorMessage);
    return false;
  }

  state.providerError = undefined;
  const text = message.content
    .filter((content): content is Extract<typeof content, { type: "text" }> =>
      content.type === "text",
    )
    .map((content) => content.text)
    .join("\n");
  if (text.trim() === "") return false;
  state.finalMessage = concise(redactSecrets(text));
  return true;
}

function recordMessages(event: AgentSessionEvent, state: PiEventState): void {
  if (event.type === "message_end") {
    const recorded = recordAssistantMessage(event.message, state);
    if (recorded) state.finalMessageStreamed = state.assistantStream !== undefined;
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

  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    state.assistantStream ??= new IncrementalSecretRedactor();
    const contentIndex = event.assistantMessageEvent.contentIndex;
    const separator = state.assistantTextContentIndex !== undefined &&
        state.assistantTextContentIndex !== contentIndex
      ? "\n"
      : "";
    state.assistantTextContentIndex = contentIndex;
    const delta = state.assistantStream.push(`${separator}${event.assistantMessageEvent.delta}`);
    return assistantDeltaEvents(delta, false);
  }

  if (event.type === "message_end" && state.assistantStream !== undefined) {
    const delta = state.assistantStream.push("", true);
    delete state.assistantStream;
    delete state.assistantTextContentIndex;
    return assistantDeltaEvents(delta, true);
  }

  if (event.type === "tool_execution_start") {
    const rawCommand = event.toolName === "bash" ? stringProperty(event.args, "command") : undefined;
    const command = rawCommand === undefined ? undefined : redactSecrets(rawCommand);
    const rawPath =
      event.toolName === "edit" || event.toolName === "write"
        ? stringProperty(event.args, "path")
        : undefined;
    const path = rawPath === undefined ? undefined : redactSecrets(rawPath);
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
  return [
    `Older summary: ${context.olderSummary || "None."}`,
    `Recent turns: ${JSON.stringify(turns)}`,
    `Recent run summaries: ${JSON.stringify(runs)}`,
    `Compaction metadata: ${JSON.stringify({ count: context.compactionCount, lastCompactedAt: context.lastCompactedAt })}`,
  ].join("\n");
}

function knowledgeSummary(input: { projectKnowledge?: { entries: readonly ProjectKnowledgeEntry[] } }): string {
  return renderProjectKnowledge(input.projectKnowledge?.entries ?? []);
}

function repositoryInstructions(input: { repoInstructions?: string }): string {
  return input.repoInstructions === undefined
    ? "Follow repository-local instructions discovered with read-only tools."
    : concise(input.repoInstructions, MAX_INSTRUCTIONS_CHARS);
}

function plannerPrompt(input: CreatePlanInput): string {
  return [
    "Create a small, executable implementation plan for the stated intent.",
    `Current Git/repository state: ${repositorySummary(input.repo)}`,
    `Repository instructions: ${repositoryInstructions(input)}`,
    `Intent: ${concise(input.intent, MAX_INSTRUCTIONS_CHARS)}`,
    `Bounded session context:\n${sessionSummary(input.sessionContext)}`,
    `Project knowledge:\n${knowledgeSummary(input)}`,
    "Inspect only as needed. You have no shell or mutation tools.",
    "Use request_human_input only for material ambiguity or a consequential approval; never elevate trivial choices.",
    ...(input.humanDecision === undefined
      ? []
      : [`Validated human response to your prior request: ${JSON.stringify(input.humanDecision.response)}`]),
    "Finish by calling submit_plan exactly once with the structured plan; do not print the plan or continue afterward.",
  ].join("\n\n");
}

function executorPrompt(input: ExecuteInput): string {
  return [
    "Implement the validated plan in the repository.",
    `Current Git/repository state: ${repositorySummary(input.repo)}`,
    `Repository instructions: ${repositoryInstructions(input)}`,
    `Intent: ${concise(input.intent, MAX_INSTRUCTIONS_CHARS)}`,
    `Validated plan: ${JSON.stringify(PlanSchema.parse(input.plan))}`,
    `Bounded session context:\n${sessionSummary(input.sessionContext)}`,
    `Project knowledge:\n${knowledgeSummary(input)}`,
    "Use record_project_knowledge only to propose concise durable facts likely to improve future coding tasks. Never record prompts, transcripts, command/tool output, or credentials.",
    "Stay within the plan. Do not commit, stage, push, or open a pull request.",
    "Use request_human_input only for material ambiguity or a consequential action (dangerous shell, dependency replacement, database migration, or large destructive change); never elevate trivial choices.",
    "An approval is scoped to its exact normalized action and can be consumed only once. Rejection or edited guidance must cancel or replan the original action.",
    ...(input.humanDecision === undefined
      ? []
      : [`Validated human response to your prior request: ${JSON.stringify(input.humanDecision.response)}`]),
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
    `Current Git/repository state: ${repositorySummary(input.repo)}`,
    `Repository instructions: ${repositoryInstructions(input)}`,
    `Intent: ${concise(input.intent, MAX_INSTRUCTIONS_CHARS)}`,
    `Validated plan: ${JSON.stringify(PlanSchema.parse(input.plan))}`,
    `Repair attempt ${input.attempt}; bounded failure context: ${failureSummary(input.failure, input.changedFiles)}`,
    `Bounded session context:\n${sessionSummary(input.sessionContext)}`,
    `Project knowledge:\n${knowledgeSummary(input)}`,
    "Use record_project_knowledge only to propose concise durable facts likely to improve future coding tasks. Never record prompts, transcripts, command/tool output, or credentials.",
    "Diagnose the failure before editing, then address only the observed failure.",
    "Never weaken or delete tests, lint rules, typecheck settings, configuration, or scripts to make verification pass.",
    "Do not commit, stage, push, or open a pull request.",
    "Use request_human_input only for material ambiguity or a consequential action; never elevate trivial choices. Rejection or edited guidance must not execute the original action.",
    ...(input.humanDecision === undefined
      ? []
      : [`Validated human response to your prior request: ${JSON.stringify(input.humanDecision.response)}`]),
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
      required: ["objective", "assumptions", "steps", "likelyFiles", "verificationStrategy"],
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

const humanDecisionParameters = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "question", "context", "risk", "action", "options", "allowCustom"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 128 },
    kind: { type: "string", enum: ["clarification", "approval"] },
    question: { type: "string", minLength: 1, maxLength: 1_000 },
    context: { anyOf: [{ type: "string", minLength: 1, maxLength: 1_000 }, { type: "null" }] },
    risk: { anyOf: [{ type: "string", minLength: 1, maxLength: 1_000 }, { type: "null" }] },
    action: { anyOf: [{ type: "string", minLength: 1, maxLength: 1_000 }, { type: "null" }] },
    options: {
      type: "array",
      minItems: 2,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "description"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 128 },
          label: { type: "string", minLength: 1, maxLength: 80 },
          description: { type: "string", minLength: 1, maxLength: 240 },
        },
      },
    },
    allowCustom: { type: "boolean" },
  },
} as ToolDefinition["parameters"];

function requestHumanInputTool(onRequest: (request: HumanDecisionRequest) => void): ToolDefinition {
  return {
    name: "request_human_input",
    label: "Request human input",
    description: "Pause for a material clarification or exact consequential-action approval.",
    parameters: humanDecisionParameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const raw = params as Record<string, unknown>;
      const request = HumanDecisionRequestSchema.parse({
        ...raw,
        ...(raw.context === null ? { context: undefined } : {}),
        ...(raw.risk === null ? { risk: undefined } : {}),
        ...(raw.action === null ? { action: undefined } : {}),
      });
      onRequest(request);
      return {
        content: [{ type: "text", text: "Human input requested. Stop now." }],
        details: {},
        terminate: true,
      };
    },
  };
}

const knowledgeParameters = {
  type: "object",
  additionalProperties: false,
  required: ["category", "text"],
  properties: {
    category: { type: "string", enum: ["architecture", "decision", "learning"] },
    text: { type: "string", minLength: 1, maxLength: 500 },
  },
} as ToolDefinition["parameters"];

function recordProjectKnowledgeTool(onEntry: (entry: ProjectKnowledgeEntry) => void): ToolDefinition {
  return {
    name: "record_project_knowledge",
    label: "Record project knowledge",
    description: "Propose one concise durable project fact to Agency. This tool does not write files.",
    parameters: knowledgeParameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const entry = ProjectKnowledgeEntrySchema.parse(params);
      onEntry(entry);
      return { content: [{ type: "text", text: "Knowledge proposal recorded for post-verification review." }], details: {} };
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
        tool: redactSecrets(event.tool),
        ...(event.detail === undefined ? {} : { detail: redactSecrets(event.detail) }),
      };
      case "file_changed": return { ...event, path: redactSecrets(event.path) };
      case "command_started":
      case "command_finished": return { ...event, command: redactSecrets(event.command) };
      case "message": return { ...event, content: redactSecrets(event.content) };
      case "assistant_text_delta": return { ...event, delta: redactSecrets(event.delta) };
      case "error": return { ...event, message: redactSecrets(event.message) };
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
  readonly #planners = new Map<string, PiSession>();
  readonly #planHandlers = new Map<string, (value: unknown) => void>();
  readonly #humanRequestHandlers = new Map<string, (request: HumanDecisionRequest) => void>();
  readonly #knowledgeHandlers = new Map<string, (entry: ProjectKnowledgeEntry) => void>();
  readonly #approvedActions = new Map<string, string>();
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

  async createPlan(input: CreatePlanInput): Promise<CreatePlanResult | import("./coding-runtime.js").HumanDecisionResult> {
    this.#assertUsable();
    assertNotAborted(input.signal);
    let submittedPlan: Plan | undefined;
    let submittedError: InfrastructureError | undefined;
    let decisionRequest: HumanDecisionRequest | undefined;
    let planner: PiSession | undefined;
    const plannerKey = input.sessionId ?? "__single_planner__";
    if (input.runtimeContinuation !== undefined && input.runtimeContinuation.role !== "planner") {
      throw infrastructure("PI_SESSION_CREATION_FAILED", "Invalid planner continuation role");
    }
    const requestHandlerKey = `planner:${plannerKey}`;
    this.#humanRequestHandlers.set(requestHandlerKey, (request) => { decisionRequest = request; });
    this.#planHandlers.set(plannerKey, (value) => {
      try {
        submittedPlan = PlanSchema.parse(value);
      } catch (error) {
        submittedError = infrastructure("PI_PLAN_INVALID", "Pi submitted an invalid plan", error);
      }
    });
    const tool = submitPlanTool((value) => this.#planHandlers.get(plannerKey)?.(value));

    try {
      planner = this.#planners.get(plannerKey) ?? (
        await this.#sdk.createAgentSession({
          cwd: input.repo.rootPath,
          modelRuntime: this.#modelRuntime,
          sessionManager: input.runtimeContinuation === undefined
            ? this.#sdk.createSessionManager(input.repo.rootPath, sessionDirectory(input.repo, "planner"))
            : this.#sdk.openSessionManager(
                input.repo.rootPath,
                sessionDirectory(input.repo, "planner"),
                continuationPath(input.repo, input.runtimeContinuation),
              ),
          resourceLoader: await this.#sdk.createResourceLoader(input.repo.rootPath),
          tools: PLANNER_TOOLS,
          customTools: [
            tool,
            requestHumanInputTool((request) => this.#humanRequestHandlers.get(requestHandlerKey)?.(request)),
          ],
        })
      ).session;
      enforceExclusiveHumanRequest(planner);
      this.#planners.set(plannerKey, planner);
    } catch (error) {
      this.#humanRequestHandlers.delete(requestHandlerKey);
      this.#planHandlers.delete(plannerKey);
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
        if (submittedPlan === undefined && submittedError === undefined && decisionRequest === undefined) {
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
      if (decisionRequest !== undefined) {
        return {
          decisionRequest,
          message: "Waiting for human input.",
          runtimeContinuation: runtimeContinuation(planner, "planner"),
        };
      }
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
      this.#humanRequestHandlers.delete(requestHandlerKey);
      this.#planHandlers.delete(plannerKey);
      if (decisionRequest === undefined) {
        const ownsPlanner = this.#planners.get(plannerKey) === planner;
        this.#planners.delete(plannerKey);
        if (ownsPlanner) planner.dispose();
      }
    }
  }

  async execute(input: ExecuteInput): Promise<CodingResult | import("./coding-runtime.js").HumanDecisionResult> {
    emit(input.onEvent, { type: "phase", phase: "executing" });
    return this.#runExecutor(input, executorPrompt(input));
  }

  async repair(input: RepairInput): Promise<CodingResult | import("./coding-runtime.js").HumanDecisionResult> {
    emit(input.onEvent, { type: "phase", phase: "repairing" });
    return this.#runExecutor(input, repairPrompt(input));
  }

  async abort(): Promise<void> {
    const sessions = new Set([
      ...this.#activeSessions,
      ...this.#executors.values(),
      ...this.#planners.values(),
    ]);
    const executors = new Set(this.#executors.values());
    const planners = new Set(this.#planners.values());
    const persistentSessions = new Set([...executors, ...planners]);
    // An aborted Pi session is not safe to reuse for a later Agency turn.
    this.#executors.clear();
    this.#planners.clear();
    this.#humanRequestHandlers.clear();
    this.#knowledgeHandlers.clear();
    this.#planHandlers.clear();
    this.#approvedActions.clear();
    await Promise.allSettled([...sessions].map((session) => session.abort()));
    for (const session of persistentSessions) session.dispose();
    this.#activeSessions.clear();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.abort();
  }

  async #runExecutor(input: ExecuteInput, prompt: string): Promise<CodingResult | import("./coding-runtime.js").HumanDecisionResult> {
    this.#assertUsable();
    assertNotAborted(input.signal);
    const session = await this.#executor(
      input.repo,
      input.sessionId,
      input.signal,
      input.runtimeContinuation,
    );
    const state = this.#subscribe(session, input.onEvent);
    this.#activeSessions.add(session);
    const executorKey = this.#executorKey(input.repo, input.sessionId);
    let decisionRequest: HumanDecisionRequest | undefined;
    const proposedKnowledge: ProjectKnowledgeEntry[] = [];
    this.#humanRequestHandlers.set(executorKey, (request) => { decisionRequest = request; });
    this.#knowledgeHandlers.set(executorKey, (entry) => { proposedKnowledge.push(entry); });
    this.#approvedActions.delete(executorKey);
    if (
      input.humanDecision?.request.kind === "approval" &&
      input.humanDecision.response.optionId === "approve" &&
      input.humanDecision.request.action !== undefined
    ) {
      this.#approvedActions.set(executorKey, normalizedAction(input.humanDecision.request.action));
    }
    const abortState = this.#attachAbort(input.signal, session, () => {
      if (this.#executors.get(executorKey) === session) this.#executors.delete(executorKey);
    });
    try {
      assertNotAborted(input.signal);
      await session.prompt(prompt);
      assertNotAborted(input.signal);
      if (decisionRequest !== undefined) {
        return {
          decisionRequest,
          message: "Waiting for human input.",
          runtimeContinuation: runtimeContinuation(session, "executor"),
          ...(proposedKnowledge.length === 0 ? {} : { proposedKnowledge }),
        };
      }
      if (state.eventState.providerError !== undefined) {
        throw infrastructure(
          "PI_PROVIDER_REQUEST_FAILED",
          `Pi execution request failed: ${state.eventState.providerError}`,
        );
      }
      const message = state.eventState.finalMessage || "Implementation is ready for independent verification.";
      if (state.eventState.finalMessageStreamed !== true) {
        emit(input.onEvent, { type: "message", content: message });
      }
      return {
        message,
        changedFiles: [...state.eventState.changedFiles],
        sessionId: session.sessionId,
        ...(proposedKnowledge.length === 0 ? {} : { proposedKnowledge }),
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
      this.#humanRequestHandlers.delete(executorKey);
      this.#knowledgeHandlers.delete(executorKey);
      this.#approvedActions.delete(executorKey);
    }
  }

  async #executor(
    repo: RepoContext,
    agencySessionId: string,
    signal: AbortSignal | undefined,
    continuation: RuntimeContinuation | undefined,
  ): Promise<PiSession> {
    const executorKey = this.#executorKey(repo, agencySessionId);
    const existing = this.#executors.get(executorKey);
    if (existing !== undefined) return existing;
    if (continuation !== undefined && continuation.role !== "executor") {
      throw infrastructure("PI_SESSION_CREATION_FAILED", "Invalid executor continuation role");
    }
    try {
      const sessionDir = sessionDirectory(repo, "executor");
      const { session } = await this.#sdk.createAgentSession({
        cwd: repo.rootPath,
        modelRuntime: this.#modelRuntime,
        sessionManager: continuation === undefined
          ? this.#sdk.createSessionManager(repo.rootPath, sessionDir)
          : this.#sdk.openSessionManager(
              repo.rootPath,
              sessionDir,
              continuationPath(repo, continuation),
            ),
        resourceLoader: await this.#sdk.createResourceLoader(repo.rootPath),
        tools: EXECUTOR_TOOLS,
        customTools: [
          protectedBashTool(
            this.#sdk.createBashTool(repo.rootPath),
            (action) => {
              const approved = this.#approvedActions.get(executorKey);
              if (approved !== action) return false;
              this.#approvedActions.delete(executorKey);
              return true;
            },
          ) as unknown as ToolDefinition,
          requestHumanInputTool((request) => this.#humanRequestHandlers.get(executorKey)?.(request)),
          recordProjectKnowledgeTool((entry) => this.#knowledgeHandlers.get(executorKey)?.(entry)),
        ],
      });
      enforceExclusiveHumanRequest(session);
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
