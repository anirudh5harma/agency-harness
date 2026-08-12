import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentSessionEvent,
  CreateAgentSessionOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { AgencyEvent, Plan, RepoContext } from "../../src/domain/index.js";
import { InfrastructureError } from "../../src/process/index.js";
import {
  PiCodingRuntime,
  bashApprovalAction,
  createSafeResourceLoader,
  normalizePiEvent,
  type PiSdkBoundary,
  type PiSession,
} from "../../src/coding/index.js";

const repo: RepoContext = {
  rootPath: "/workspace/agency",
  currentBranch: "main",
  defaultBranch: "main",
  isDirty: false,
  project: {
    name: "agency",
    version: "0.0.0",
    languages: ["TypeScript"],
    packageManager: "npm",
    scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
  },
};

const plan: Plan = {
  objective: "Add the Agency/Pi boundary",
  assumptions: ["Pi 0.84.1 is installed"],
  steps: [{ id: "runtime", description: "Implement the coding runtime" }],
  likelyFiles: ["src/coding/pi-coding-runtime.ts"],
  verificationStrategy: ["Run focused tests", "Run typecheck"],
};

function assistantMessage(content: string): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning", thinkingSignature: "secret" },
        { type: "text", text: content },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    },
  } as AgentSessionEvent;
}

function assistantTextDelta(delta: string, contentIndex = 0): AgentSessionEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex,
      delta,
      partial: { role: "assistant", content: [] },
    },
  } as AgentSessionEvent;
}

function assistantThinkingDelta(delta: string): AgentSessionEvent {
  return {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta,
      partial: { role: "assistant", content: [] },
    },
  } as AgentSessionEvent;
}

function providerErrorMessage(errorMessage: string): Extract<AgentSessionEvent, { type: "message_end" }> {
  const event = assistantMessage("hidden provider response") as Extract<
    AgentSessionEvent,
    { type: "message_end" }
  >;
  return {
    ...event,
    message: {
      ...event.message,
      stopReason: "error",
      errorMessage,
    },
  };
}

class StubSession implements PiSession {
  readonly agent = {} as NonNullable<PiSession["agent"]>;
  readonly abort = vi.fn(async () => {});
  readonly dispose = vi.fn(() => {});
  readonly prompts: string[] = [];
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  constructor(
    readonly sessionId: string,
    readonly onPrompt: (session: StubSession, prompt: string) => Promise<void>,
  ) {}
  get sessionFile(): string {
    return `/workspace/agency/.devagency/pi-sessions/${this.sessionId}/${this.sessionId}.jsonl`;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  async prompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    await this.onPrompt(this, prompt);
  }
}

function createBoundary(options: {
  executorPrompt?: (session: StubSession, prompt: string) => Promise<void>;
  plannerPrompt?: (session: StubSession, prompt: string) => Promise<void>;
  plannerValue?: unknown;
  createSession?: (
    sessionOptions: CreateAgentSessionOptions,
    createDefault: () => Promise<{ session: StubSession }>,
  ) => Promise<{ session: StubSession }>;
}) {
  const sessionOptions: CreateAgentSessionOptions[] = [];
  const sessions: StubSession[] = [];
  const submitResults: unknown[] = [];
  const modelRuntime = { runtime: true };
  const persistentManager = { manager: "persistent" };
  const resourceLoader = { loader: "safe" };
  const bashTool: ToolDefinition = {
    name: "bash",
    label: "Bash",
    description: "Run a shell command",
    parameters: { type: "object" } as never,
    async execute() {
      return { content: [{ type: "text", text: "allowed" }], details: {} };
    },
  };
  const fileTool = (name: string): ToolDefinition => ({
    name,
    label: name,
    description: `${name} through test boundary`,
    parameters: { type: "object" } as never,
    async execute() {
      return { content: [{ type: "text", text: "allowed" }], details: {} };
    },
  });
  const sdk: PiSdkBoundary = {
    createModelRuntime: vi.fn(async () => modelRuntime as never),
    createSessionManager: vi.fn(() => persistentManager as never),
    openSessionManager: vi.fn(() => persistentManager as never),
    createResourceLoader: vi.fn(async () => resourceLoader as never),
    detectVerificationCommands: vi.fn(async () => [
      { name: "test", command: "npm", args: ["run", "test"], required: true },
      { name: "typecheck", command: "npm", args: ["run", "typecheck"], required: true },
      { name: "lint", command: "npm", args: ["run", "lint"], required: true },
      { name: "build", command: "npm", args: ["run", "build"], required: true },
    ]),
    createReadTool: vi.fn(() => fileTool("read") as never),
    createGrepTool: vi.fn(() => fileTool("grep") as never),
    createFindTool: vi.fn(() => fileTool("find") as never),
    createLsTool: vi.fn(() => fileTool("ls") as never),
    createEditTool: vi.fn(() => fileTool("edit") as never),
    createWriteTool: vi.fn(() => fileTool("write") as never),
    createBashTool: vi.fn(() => bashTool as never),
    createAgentSession: vi.fn(async (sessionOptionsInput) => {
      const createDefault = async () => {
      sessionOptions.push(sessionOptionsInput);
      const isPlanner = sessionOptionsInput.tools?.includes("submit_plan") === true;
      const session = new StubSession(
        isPlanner ? "planner" : "executor",
        isPlanner
          ? (options.plannerPrompt ?? (async (planner) => {
              const submit = sessionOptionsInput.customTools?.[0] as ToolDefinition;
              planner.emit({
                type: "tool_execution_start",
                toolCallId: "plan-1",
                toolName: "submit_plan",
                args: { plan: options.plannerValue ?? plan },
              });
              submitResults.push(
                await submit.execute(
                  "plan-1",
                  { plan: options.plannerValue ?? plan },
                  undefined,
                  undefined,
                  {} as never,
                ),
              );
              planner.emit({
                type: "tool_execution_end",
                toolCallId: "plan-1",
                toolName: "submit_plan",
                result: { content: [{ type: "text", text: "accepted" }] },
                isError: false,
              });
            }))
          : (options.executorPrompt ?? (async () => {})),
      );
      sessions.push(session);
      return { session };
      };
      return options.createSession?.(sessionOptionsInput, createDefault) ?? createDefault();
    }),
  };
  return {
    sdk,
    sessionOptions,
    sessions,
    submitResults,
    modelRuntime,
    persistentManager,
    resourceLoader,
  };
}

describe("PiCodingRuntime", () => {
  it("bounds a provider prompt that never settles", async () => {
    const boundary = createBoundary({
      executorPrompt: async () => await new Promise<void>(() => {}),
    });
    const runtime = await PiCodingRuntime.create({
      sdk: boundary.sdk,
      promptTimeoutMs: 10,
      abortTimeoutMs: 10,
    });

    await expect(
      runtime.execute({ intent: "Build", repo, plan, sessionId: "agency-timeout" }),
    ).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "PI_REQUEST_TIMED_OUT",
      message: "Pi execution request exceeded its deadline",
    });
  });

  it("preserves a typed deadline failure for a planner that never settles", async () => {
    const boundary = createBoundary({
      plannerPrompt: async () => await new Promise<void>(() => {}),
    });
    const runtime = await PiCodingRuntime.create({
      sdk: boundary.sdk,
      promptTimeoutMs: 10,
      abortTimeoutMs: 10,
    });

    await expect(runtime.createPlan({ intent: "Plan", repo })).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "PI_REQUEST_TIMED_OUT",
      message: "Pi planning request exceeded its deadline",
    });
  });

  it("bounds public abort when an SDK session never acknowledges cancellation", async () => {
    const boundary = createBoundary({});
    const runtime = await PiCodingRuntime.create({
      sdk: boundary.sdk,
      abortTimeoutMs: 10,
    });
    await runtime.execute({ intent: "Build", repo, plan, sessionId: "agency-abort-timeout" });
    boundary.sessions[0]!.abort.mockImplementation(async () => await new Promise<void>(() => {}));

    await expect(runtime.abort()).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "PI_SESSION_ABORT_FAILED",
      message: "Pi session abort exceeded its deadline",
    });
    expect(boundary.sessions[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("preserves AbortSignal cancellation when both prompt and SDK abort never settle", async () => {
    const controller = new AbortController();
    const boundary = createBoundary({
      executorPrompt: async () => {
        controller.abort();
        await new Promise<void>(() => {});
      },
      createSession: async (_options, createDefault) => {
        const created = await createDefault();
        created.session.abort.mockImplementation(async () => await new Promise<void>(() => {}));
        return created;
      },
    });
    const runtime = await PiCodingRuntime.create({
      sdk: boundary.sdk,
      promptTimeoutMs: 1_000,
      abortTimeoutMs: 10,
    });

    await expect(runtime.execute({
      intent: "Build",
      repo,
      plan,
      sessionId: "agency-cancel-timeout",
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(boundary.sessions[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("captures validated knowledge proposals without writing and labels bounded prompt context", async () => {
    const boundary = createBoundary({
      executorPrompt: async (_session, prompt) => {
        expect(prompt).toContain("Older summary:");
        expect(prompt).toContain("Recent turns:");
        expect(prompt).toContain("Recent run summaries:");
        expect(prompt).toContain("Current Git/repository state:");
        expect(prompt).toContain("Project knowledge:\nArchitecture:");
        const tool = boundary.sessionOptions.at(-1)?.customTools?.find(({ name }) => name === "record_project_knowledge");
        await tool!.execute("knowledge-1", { category: "architecture", text: "token=do-not-store" }, undefined, undefined, {} as never);
      },
    });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });
    const result = await runtime.execute({
      intent: "Build",
      repo,
      plan,
      sessionId: "agency-knowledge",
      sessionContext: {
        sessionId: "agency-knowledge",
        olderSummary: "Earlier objective completed.",
        compactionCount: 1,
        lastCompactedAt: "2026-01-01T00:00:00.000Z",
        recentTurns: [{ role: "user", content: "current task" }],
        runSummaries: [],
      },
      projectKnowledge: {
        entries: [{ category: "architecture", text: "The graph owns verification." }],
      },
    });
    expect(result).toMatchObject({ proposedKnowledge: [{ category: "architecture", text: "token=[REDACTED]" }] });
  });
  it("pauses and continues the same planner session for human clarification", async () => {
    let prompts = 0;
    const boundary = createBoundary({
      plannerPrompt: async () => {
        prompts += 1;
        if (prompts === 1) {
          const tool = boundary.sessionOptions[0]?.customTools?.find(
            ({ name }) => name === "request_human_input",
          );
          await tool!.execute("human-1", {
            id: "storage-choice",
            kind: "clarification",
            question: "Which storage backend should be used?",
            options: [
              { id: "sqlite", label: "SQLite", description: "Use a local file." },
              { id: "postgres", label: "Postgres", description: "Use the service database." },
            ],
            allowCustom: true,
          }, undefined, undefined, {} as never);
          return;
        }
        const submit = boundary.sessionOptions[0]?.customTools?.find(
          ({ name }) => name === "submit_plan",
        );
        await submit!.execute("plan-2", { plan }, undefined, undefined, {} as never);
      },
    });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });

    const paused = await runtime.createPlan({
      intent: "Build",
      repo,
      sessionId: "agency-1",
    });
    expect(paused).toMatchObject({ decisionRequest: { id: "storage-choice" } });
    const humanRequestHook = boundary.sessions[0]?.agent.beforeToolCall;

    await expect(runtime.createPlan({
      intent: "Build",
      repo,
      sessionId: "agency-1",
      humanDecision: {
        request: (paused as { decisionRequest: import("../../src/domain/index.js").HumanDecisionRequest }).decisionRequest,
        response: { requestId: "storage-choice", optionId: "sqlite" },
      },
    })).resolves.toEqual({ plan, message: "Plan ready for execution." });

    expect(boundary.sessions).toHaveLength(1);
    expect(boundary.sessions[0]?.agent.beforeToolCall).toBe(humanRequestHook);
    expect(boundary.sessions[0]?.prompts[1]).toContain('"optionId":"sqlite"');
    expect(boundary.sessions[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("reopens the exact persisted planner after constructing a new runtime", async () => {
    let prompts = 0;
    const boundary = createBoundary({
      plannerPrompt: async () => {
        prompts += 1;
        const tools = boundary.sessionOptions.at(-1)?.customTools ?? [];
        if (prompts === 1) {
          await tools.find(({ name }) => name === "request_human_input")!.execute(
            "human-1",
            {
              id: "restart-choice",
              kind: "clarification",
              question: "Which implementation should continue?",
              options: [
                { id: "one", label: "One", description: "Use the first implementation." },
                { id: "two", label: "Two", description: "Use the second implementation." },
              ],
              allowCustom: true,
            },
            undefined,
            undefined,
            {} as never,
          );
        } else {
          await tools.find(({ name }) => name === "submit_plan")!.execute(
            "plan-2", { plan }, undefined, undefined, {} as never,
          );
        }
      },
    });
    const firstRuntime = await PiCodingRuntime.create({ sdk: boundary.sdk });
    const paused = await firstRuntime.createPlan({
      intent: "Build",
      repo,
      sessionId: "agency-restart",
    });
    expect(paused).toMatchObject({
      runtimeContinuation: { role: "planner", sessionFile: "planner.jsonl" },
    });

    const secondRuntime = await PiCodingRuntime.create({ sdk: boundary.sdk });
    await expect(secondRuntime.createPlan({
      intent: "Build",
      repo,
      sessionId: "agency-restart",
      runtimeContinuation: (paused as import("../../src/coding/index.js").HumanDecisionResult).runtimeContinuation,
      humanDecision: {
        request: (paused as import("../../src/coding/index.js").HumanDecisionResult).decisionRequest,
        response: { requestId: "restart-choice", optionId: "one" },
      },
    })).resolves.toEqual({ plan, message: "Plan ready for execution." });

    expect(boundary.sdk.openSessionManager).toHaveBeenCalledWith(
      repo.rootPath,
      "/workspace/agency/.devagency/pi-sessions/planner",
      "/workspace/agency/.devagency/pi-sessions/planner/planner.jsonl",
    );
    expect(boundary.sessions).toHaveLength(2);
  });

  it("scopes consequential shell approval to the exact command for one use", async () => {
    const testRepo = { ...repo, rootPath: process.cwd() };
    const command = "rm -rf build";
    const action = bashApprovalAction(["rm", "-rf", "build"]);
    let prompts = 0;
    let firstRun: unknown;
    let secondError: unknown;
    let rejectedError: unknown;
    const boundary = createBoundary({
      executorPrompt: async () => {
        prompts += 1;
        const tools = boundary.sessionOptions[0]?.customTools ?? [];
        if (prompts === 1) {
          const request = tools.find(({ name }) => name === "request_human_input");
          await request!.execute("human-1", {
            id: "migration-approval",
            kind: "approval",
            question: "Approve the migration?",
            risk: "This changes the database schema.",
            action,
            options: [
              { id: "approve", label: "Approve", description: "Run it once." },
              { id: "reject", label: "Reject", description: "Cancel it." },
              { id: "edit", label: "Edit", description: "Change the instruction." },
            ],
            allowCustom: true,
          }, undefined, undefined, {} as never);
          return;
        }
        const bash = tools.find(({ name }) => name === "bash")!;
        if (prompts === 2) {
          firstRun = await bash.execute("bash-1", { command }, undefined, undefined, {} as never);
          try {
            await bash.execute("bash-2", { command }, undefined, undefined, {} as never);
          } catch (error) {
            secondError = error;
          }
        } else {
          try {
            await bash.execute("bash-3", { command }, undefined, undefined, {} as never);
          } catch (error) {
            rejectedError = error;
          }
        }
      },
    });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });
    const paused = await runtime.execute({ intent: "Build", repo: testRepo, plan, sessionId: "agency-1" });
    const request = (paused as { decisionRequest: import("../../src/domain/index.js").HumanDecisionRequest }).decisionRequest;

    await runtime.execute({
      intent: "Build",
      repo: testRepo,
      plan,
      sessionId: "agency-1",
      humanDecision: {
        request,
        response: { requestId: request.id, optionId: "approve" },
      },
    });

    expect(firstRun).toBeDefined();
    expect(secondError).toBeInstanceOf(Error);
    expect((secondError as Error).message).toContain("one-shot approval");

    await runtime.execute({
      intent: "Build",
      repo: testRepo,
      plan,
      sessionId: "agency-1",
      humanDecision: {
        request,
        response: { requestId: request.id, optionId: "reject" },
      },
    });
    expect(rejectedError).toBeInstanceOf(Error);
    expect((rejectedError as Error).message).toContain("explicit one-shot approval");
  });

  it("reopens the exact persisted executor after constructing a new runtime", async () => {
    let prompts = 0;
    const boundary = createBoundary({
      executorPrompt: async () => {
        prompts += 1;
        if (prompts !== 1) return;
        const request = boundary.sessionOptions.at(-1)?.customTools?.find(
          ({ name }) => name === "request_human_input",
        );
        await request!.execute("human-1", {
          id: "executor-restart",
          kind: "clarification",
          question: "Which implementation?",
          options: [
            { id: "one", label: "One", description: "Choose one." },
            { id: "two", label: "Two", description: "Choose two." },
          ],
          allowCustom: true,
        }, undefined, undefined, {} as never);
      },
    });
    const firstRuntime = await PiCodingRuntime.create({ sdk: boundary.sdk });
    const paused = await firstRuntime.execute({ intent: "Build", repo, plan, sessionId: "agency-restart" });
    expect(paused).toMatchObject({
      runtimeContinuation: { role: "executor", sessionFile: "executor.jsonl" },
    });

    const secondRuntime = await PiCodingRuntime.create({ sdk: boundary.sdk });
    const human = paused as import("../../src/coding/index.js").HumanDecisionResult;
    await expect(secondRuntime.execute({
      intent: "Build",
      repo,
      plan,
      sessionId: "agency-restart",
      ...(human.runtimeContinuation === undefined ? {} : { runtimeContinuation: human.runtimeContinuation }),
      humanDecision: {
        request: human.decisionRequest,
        response: { requestId: "executor-restart", optionId: "one" },
      },
    })).resolves.toMatchObject({ sessionId: "executor" });

    expect(boundary.sdk.openSessionManager).toHaveBeenCalledWith(
      repo.rootPath,
      "/workspace/agency/.devagency/pi-sessions/executor",
      "/workspace/agency/.devagency/pi-sessions/executor/executor.jsonl",
    );
  });

  it("rejects runtime continuation paths outside Agency-owned storage", async () => {
    const boundary = createBoundary({});
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });

    await expect(runtime.execute({
      intent: "Build",
      repo,
      plan,
      sessionId: "agency-restart",
      runtimeContinuation: { role: "executor", sessionFile: "../outside.jsonl" },
    })).rejects.toMatchObject({ code: "PI_SESSION_CREATION_FAILED" });
    expect(boundary.sdk.openSessionManager).not.toHaveBeenCalled();
  });

  it("uses one model runtime and a persistent read-only planner with submit_plan", async () => {
    const boundary = createBoundary({});
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });
    const events: AgencyEvent[] = [];

    await expect(
      runtime.createPlan({
        intent: "Implement the boundary",
        repo,
        repoInstructions: "Use ESM and do not commit.",
        onEvent: (event) => events.push(event),
      }),
    ).resolves.toEqual({ plan, message: "Plan ready for execution." });

    expect(boundary.sdk.createModelRuntime).toHaveBeenCalledOnce();
    expect(boundary.sdk.createSessionManager).toHaveBeenCalledWith(
      repo.rootPath,
      "/workspace/agency/.devagency/pi-sessions/planner",
    );
    expect(boundary.sessionOptions[0]).toMatchObject({
      cwd: repo.rootPath,
      modelRuntime: boundary.modelRuntime,
      sessionManager: boundary.persistentManager,
      resourceLoader: boundary.resourceLoader,
      tools: ["read", "grep", "find", "ls", "submit_plan", "request_human_input"],
    });
    expect(boundary.sessionOptions[0]?.tools).not.toEqual(
      expect.arrayContaining(["bash", "edit", "write"]),
    );
    expect(boundary.sdk.createResourceLoader).toHaveBeenCalledWith(repo.rootPath);
    expect(boundary.sessionOptions[0]?.customTools?.[0]?.name).toBe("submit_plan");
    expect(boundary.sessionOptions[0]?.customTools?.map(({ name }) => name)).toEqual([
      "submit_plan", "read", "grep", "find", "ls", "request_human_input",
    ]);
    type StrictObjectSchema = {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    const submitPlanParameters = boundary.sessionOptions[0]?.customTools?.[0]
      ?.parameters as StrictObjectSchema;
    const planParameters = submitPlanParameters.properties.plan as StrictObjectSchema;
    const stepParameters = (planParameters.properties.steps as { items: StrictObjectSchema }).items;
    for (const parameters of [submitPlanParameters, planParameters, stepParameters]) {
      expect(parameters.additionalProperties).toBe(false);
      expect(new Set(parameters.required)).toEqual(new Set(Object.keys(parameters.properties)));
    }
    expect(boundary.submitResults).toEqual([
      {
        content: [{ type: "text", text: "Plan accepted. Stop now." }],
        details: {},
        terminate: true,
      },
    ]);
    expect(boundary.sessions[0]?.prompts[0]).toContain("Use ESM and do not commit.");
    expect(boundary.sessions[0]?.prompts[0]).toContain("Implement the boundary");
    expect(boundary.sessions[0]?.dispose).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: "tool", tool: "submit_plan" });
  });

  it("validates submitted plans through PlanSchema", async () => {
    const boundary = createBoundary({ plannerValue: { objective: "invalid" } });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });

    await expect(runtime.createPlan({ intent: "Build", repo })).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "PI_PLAN_INVALID",
    });
  });

  it("creates one persistent executor with the explicit tool set and reuses it for repair", async () => {
    const boundary = createBoundary({
      executorPrompt: async (session) => {
        session.emit({
          type: "tool_execution_start",
          toolCallId: "edit-1",
          toolName: "edit",
          args: { path: "src/coding/runtime.ts", edits: [] },
        });
        session.emit({
          type: "tool_execution_end",
          toolCallId: "edit-1",
          toolName: "edit",
          result: { content: [] },
          isError: false,
        });
        session.emit(assistantMessage("Implemented the requested change. Ready for verification."));
      },
    });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });

    const execution = await runtime.execute({ intent: "Build", repo, plan, sessionId: "agency-1" });
    const repair = await runtime.repair({
      intent: "Build",
      repo,
      plan,
      sessionId: "agency-1",
      attempt: 1,
      changedFiles: ["src/coding/runtime.ts"],
      failure: {
        stage: "verifying",
        message: "One focused test failed",
        cause: "expected true",
        recoverable: true,
        command: {
          command: "npm test",
          args: [],
          cwd: repo.rootPath,
          exitCode: 1,
          signal: null,
          stdout: `stdout-marker ${"o".repeat(2_000)}`,
          stderr: `stderr-marker ${"e".repeat(2_000)}`,
          durationMs: 10,
          timedOut: false,
        },
      },
    });

    expect(boundary.sdk.createSessionManager).toHaveBeenCalledOnce();
    expect(boundary.sdk.createSessionManager).toHaveBeenCalledWith(
      repo.rootPath,
      "/workspace/agency/.devagency/pi-sessions/executor",
    );
    expect(boundary.sessionOptions[0]).toMatchObject({
      cwd: repo.rootPath,
      modelRuntime: boundary.modelRuntime,
      sessionManager: boundary.persistentManager,
      tools: [
        "read", "grep", "find", "ls", "edit", "write", "bash",
        "request_human_input", "record_project_knowledge",
      ],
      resourceLoader: boundary.resourceLoader,
    });
    expect(boundary.sessionOptions[0]?.customTools?.map(({ name }) => name)).toEqual([
      "read", "grep", "find", "ls", "edit", "write", "bash",
      "request_human_input", "record_project_knowledge",
    ]);
    expect(execution).toEqual({
      message: "Implemented the requested change. Ready for verification.",
      changedFiles: ["src/coding/runtime.ts"],
      sessionId: "executor",
    });
    expect(repair.sessionId).toBe(execution.sessionId);
    expect(boundary.sessions).toHaveLength(1);
    expect(boundary.sessions[0]?.prompts[0]).toContain(JSON.stringify(plan));
    expect(boundary.sessions[0]?.prompts[0]).toContain("Do not commit");
    expect(boundary.sessions[0]?.prompts[0]).toContain("independent verification");
    expect(boundary.sessions[0]?.prompts[1]).toContain("One focused test failed");
    expect(boundary.sessions[0]?.prompts[1]).toContain("attempt 1");
    expect(boundary.sessions[0]?.prompts[1]).toContain('"changedFiles":["src/coding/runtime.ts"]');
    expect(boundary.sessions[0]?.prompts[1]).toContain("Diagnose the failure before editing");
    expect(boundary.sessions[0]?.prompts[1]).toContain("Never weaken or delete tests");
    expect(boundary.sessions[0]?.prompts[1]).toContain("stdout-marker");
    expect(boundary.sessions[0]?.prompts[1]).toContain("stderr-marker");
    expect(boundary.sessions[0]?.prompts[1]?.length).toBeLessThan(10_000);
  });

  it("streams assistant text while returning the final message without duplicating it", async () => {
    const boundary = createBoundary({
      executorPrompt: async (session) => {
        session.emit(assistantTextDelta("Implemented "));
        session.emit(assistantTextDelta("safely."));
        session.emit(assistantMessage("Implemented safely."));
      },
    });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });
    const events: AgencyEvent[] = [];

    const result = await runtime.execute({
      intent: "Build",
      repo,
      plan,
      sessionId: "agency-stream",
      onEvent: (event) => events.push(event),
    });

    expect(result).toMatchObject({ message: "Implemented safely." });
    expect(events.filter(({ type }) => type === "assistant_text_delta")).toEqual([
      { type: "assistant_text_delta", delta: "Implemented ", done: false },
      { type: "assistant_text_delta", delta: "safely.", done: false },
      { type: "assistant_text_delta", delta: "", done: true },
    ]);
    expect(events).not.toContainEqual({ type: "message", content: "Implemented safely." });
  });

  it("isolates executor sessions by Agency session while reusing execute-to-repair", async () => {
    const boundary = createBoundary({});
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });

    await runtime.execute({ intent: "First", repo, plan, sessionId: "agency-1" });
    await runtime.repair({
      intent: "First",
      repo,
      plan,
      sessionId: "agency-1",
      attempt: 1,
      changedFiles: [],
      failure: { stage: "verifying", message: "failed", recoverable: true },
    });
    await runtime.execute({ intent: "New", repo, plan, sessionId: "agency-2" });

    expect(boundary.sessions).toHaveLength(2);
    expect(boundary.sdk.createSessionManager).toHaveBeenCalledTimes(2);
  });

  it("aborts a session created after its signal was aborted and never prompts it", async () => {
    let releaseCreation!: () => void;
    const creationBlocked = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const boundary = createBoundary({
      createSession: async (_options, createDefault) => {
        await creationBlocked;
        return createDefault();
      },
    });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });
    const controller = new AbortController();

    const execution = runtime.execute({
      intent: "Build",
      repo,
      plan,
      sessionId: "agency-1",
      signal: controller.signal,
    });
    controller.abort();
    releaseCreation();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(boundary.sessions[0]?.abort).toHaveBeenCalledOnce();
    expect(boundary.sessions[0]?.prompts).toEqual([]);
  });

  it("blocks repository-publishing git commands at the bash tool boundary", async () => {
    const testRepo = { ...repo, rootPath: process.cwd() };
    const boundary = createBoundary({});
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });
    await runtime.execute({ intent: "Build", repo: testRepo, plan, sessionId: "agency-1" });
    const bash = boundary.sessionOptions[0]?.customTools?.find((tool) => tool.name === "bash");
    expect(bash).toBeDefined();

    const invoke = (command: string) => bash!.execute(
      "bash-1",
      { command },
      undefined,
      undefined,
      {} as never,
    );
    await expect(invoke("git status --short")).resolves.toBeDefined();
    await expect(invoke("git add src && git commit -m nope")).rejects.toThrow(
      "Agency policy blocks",
    );
    await expect(invoke("gh pr create --fill")).rejects.toThrow("Agency policy blocks");

    for (const bypass of [
      `"git" "add" src`,
      `git 'commit' -m nope`,
      `sh -c 'git add src'`,
      `gh pr "create" --fill`,
      `gh --repo owner/project pr create --fill`,
      `git config alias.ship 'push origin HEAD'`,
      `git ship`,
      `alias g=git; g add src`,
      `./scripts/publish.sh`,
    ]) {
      await expect(invoke(bypass), bypass).rejects.toThrow("Agency policy blocks");
    }

    await expect(invoke("npm run test")).resolves.toBeDefined();
    await expect(invoke("git diff -- src/coding/tool-policy.ts")).resolves.toBeDefined();

    for (const destructive of ["rm -rf build", "rm -fr build", "rm --recursive build"]) {
      await expect(invoke(destructive), destructive).rejects.toThrow("one-shot approval");
    }
  });

  it("blocks every sibling when human input is requested in a mixed tool batch", async () => {
    const boundary = createBoundary({});
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });
    await runtime.execute({ intent: "Build", repo, plan, sessionId: "agency-1" });
    const hook = boundary.sessions[0]?.agent.beforeToolCall;
    expect(hook).toBeDefined();

    for (const names of [
      ["request_human_input", "edit", "bash"],
      ["bash", "edit", "request_human_input"],
    ]) {
      const content = names.map((name) => ({ type: "toolCall", name }));
      for (const name of ["edit", "bash"]) {
        await expect(hook!({
          assistantMessage: { content },
          toolCall: { name },
        } as never)).resolves.toEqual(expect.objectContaining({ block: true, terminate: true }));
      }
      await expect(hook!({
        assistantMessage: { content },
        toolCall: { name: "request_human_input" },
      } as never)).resolves.toBeUndefined();
    }
  });

  it("does not load target-project context files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agency-pi-loader-"));
    try {
      await writeFile(join(cwd, "AGENTS.md"), "UNTRUSTED PROJECT INSTRUCTIONS");
      const loader = await createSafeResourceLoader(cwd);

      expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("waits for cancellation and replaces the aborted executor before the next turn", async () => {
    let releaseAbort!: () => void;
    const abortBlocked = new Promise<void>((resolve) => { releaseAbort = resolve; });
    const controller = new AbortController();
    const boundary = createBoundary({
      createSession: async (_options, createDefault) => {
        const created = await createDefault();
        if (boundary.sessions.length === 1) {
          created.session.abort.mockImplementation(async () => abortBlocked);
        }
        return created;
      },
      executorPrompt: async () => {
        controller.abort();
      },
    });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });

    const cancelled = runtime.execute({
      intent: "Build",
      repo,
      plan,
      sessionId: "agency-1",
      signal: controller.signal,
    });
    void cancelled.catch(() => {});
    await vi.waitFor(() => expect(boundary.sessions[0]?.abort).toHaveBeenCalledOnce());

    const retry = runtime.execute({ intent: "Retry", repo, plan, sessionId: "agency-1" });
    await expect(retry).resolves.toBeDefined();
    expect(boundary.sessions).toHaveLength(2);

    let settled = false;
    void cancelled.finally(() => { settled = true; }).catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseAbort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(boundary.sessions[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("maps SDK failures to typed infrastructure failures and aborts active sessions", async () => {
    const boundary = createBoundary({
      executorPrompt: async () => {
        throw new Error("provider offline");
      },
    });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });

    await expect(runtime.execute({ intent: "Build", repo, plan, sessionId: "agency-1" })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InfrastructureError && error.code === "PI_PROVIDER_REQUEST_FAILED",
    );
    await runtime.abort();
    await runtime.dispose();

    expect(boundary.sessions[0]?.abort).toHaveBeenCalled();
    expect(boundary.sessions[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("surfaces safe provider errors from thrown planner failures and executor events", async () => {
    const secret = "sk-provider-secret";
    const longTail = "x".repeat(4_000);
    const providerError =
      `No API key found for the selected model. Bearer bearer-secret token=${secret} ${longTail}`;
    const boundary = createBoundary({
      plannerPrompt: async () => {
        throw new Error(
          "No API key found for the selected model.\n\nUse /login or set a provider API key.",
        );
      },
      executorPrompt: async (session) => {
        const messageEvent = providerErrorMessage(providerError);
        session.emit({
          type: "agent_end",
          messages: [messageEvent.message],
          willRetry: false,
        });
      },
    });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });

    const planningError = await runtime.createPlan({ intent: "Build", repo }).catch((error) => error);
    const executionError = await runtime.execute({ intent: "Build", repo, plan, sessionId: "agency-1" }).catch((error) => error);

    expect(planningError.message).not.toContain("Use /login");

    for (const [error, prefix] of [
      [planningError, "Pi planning request failed: No API key found for the selected model."],
      [executionError, "Pi execution request failed: No API key found for the selected model."],
    ] as const) {
      expect(error).toBeInstanceOf(InfrastructureError);
      expect(error).toMatchObject({ code: "PI_PROVIDER_REQUEST_FAILED" });
      expect(error.message).toContain(prefix);
      expect(error.message.length).toBeLessThan(600);
      expect(error.message).not.toContain("bearer-secret");
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain("private reasoning");
      expect(error.message).not.toContain("hidden provider response");
      expect(error.message).not.toContain(longTail);
    }
  });

  it("keeps arbitrary thrown planner errors private", async () => {
    const boundary = createBoundary({
      plannerPrompt: async () => {
        throw new Error("internal prompt and tool output must stay private");
      },
    });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });

    await expect(runtime.createPlan({ intent: "Build", repo })).rejects.toMatchObject({
      code: "PI_PROVIDER_REQUEST_FAILED",
      message: "Pi planning request failed",
    });
  });
});

describe("normalizePiEvent", () => {
  it("normalizes each provider turn without exposing provider payload", () => {
    const state = { calls: new Map(), changedFiles: new Set<string>(), finalMessage: "", providerError: undefined };
    expect(normalizePiEvent({ type: "turn_start" } as AgentSessionEvent, state)).toEqual([{ type: "model_turn" }]);
  });

  it("emits only exact safe AgencyEvent variants and never thinking or raw output", () => {
    const state = {
      calls: new Map(),
      changedFiles: new Set<string>(),
      finalMessage: "",
      providerError: undefined,
    };
    const events = [
      ...normalizePiEvent(
        {
          type: "tool_execution_start",
          toolCallId: "bash-1",
          toolName: "bash",
          args: { command: "npm test" },
        },
        state,
        100,
      ),
      ...normalizePiEvent(
        {
          type: "tool_execution_end",
          toolCallId: "bash-1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "very large raw output" }] },
          isError: false,
        },
        state,
        125,
      ),
      ...normalizePiEvent(assistantMessage("Concise final message"), state, 130),
    ];

    expect(events).toEqual([
      { type: "tool", tool: "bash" },
      { type: "command_started", command: "npm test" },
      { type: "command_finished", command: "npm test", exitCode: 0, durationMs: 25 },
    ]);
    expect(state.finalMessage).toBe("Concise final message");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(JSON.stringify(events)).not.toContain("very large raw output");
  });

  it("redacts secrets from command events before emission", () => {
    const state = {
      calls: new Map(),
      changedFiles: new Set<string>(),
      finalMessage: "",
      providerError: undefined,
    };
    const command = "curl -H 'Authorization: Bearer bearer-secret' -d 'password=hunter2&api_key=sk-secret123'";
    const events = normalizePiEvent({
      type: "tool_execution_start",
      toolCallId: "bash-secret",
      toolName: "bash",
      args: { command },
    }, state, 100);

    expect(events).toEqual([
      { type: "tool", tool: "bash" },
      { type: "command_started", command: expect.stringContaining("[REDACTED]") },
    ]);
    expect(JSON.stringify(events)).not.toContain("bearer-secret");
    expect(JSON.stringify(events)).not.toContain("hunter2");
    expect(JSON.stringify(events)).not.toContain("sk-secret123");
  });

  it("streams only text deltas and flushes at message end", () => {
    const state = {
      calls: new Map(),
      changedFiles: new Set<string>(),
      finalMessage: "",
      providerError: undefined,
    };

    expect(normalizePiEvent(assistantThinkingDelta("private chain of thought"), state)).toEqual([]);
    expect(normalizePiEvent(assistantTextDelta("Visible "), state)).toEqual([
      { type: "assistant_text_delta", delta: "Visible ", done: false },
    ]);
    expect(normalizePiEvent(assistantTextDelta("answer"), state)).toEqual([
      { type: "assistant_text_delta", delta: "answer", done: false },
    ]);
    expect(normalizePiEvent(assistantMessage("Visible answer"), state)).toEqual([
      { type: "assistant_text_delta", delta: "", done: true },
    ]);
  });

  it.each([
    [["Key: s", "k-secret123", " done"], "Key: [REDACTED] done"],
    [["Auth: Bear", "er bearer-secret", "\nnext"], "Auth: Bearer [REDACTED]\nnext"],
    [["token=", "hunter", "2 done"], "token=[REDACTED] done"],
  ])("redacts secrets split across assistant deltas", (parts, expected) => {
    const state = {
      calls: new Map(),
      changedFiles: new Set<string>(),
      finalMessage: "",
      providerError: undefined,
    };
    const events = parts.flatMap((part) => normalizePiEvent(assistantTextDelta(part), state));
    events.push(...normalizePiEvent(assistantMessage(parts.join("")), state));
    const rendered = events
      .filter((event): event is Extract<AgencyEvent, { type: "assistant_text_delta" }> =>
        event.type === "assistant_text_delta",
      )
      .map(({ delta }) => delta)
      .join("");

    expect(rendered).toBe(expected);
    expect(rendered).not.toContain("secret123");
    expect(rendered).not.toContain("bearer-secret");
    expect(rendered).not.toContain("hunter2");
  });

  it("keeps assignment values sensitive across whitespace and escaped quote chunks", () => {
    const state = {
      calls: new Map(),
      changedFiles: new Set<string>(),
      finalMessage: "",
      providerError: undefined,
    };
    const events = [
      ...normalizePiEvent(assistantTextDelta("token="), state),
      ...normalizePiEvent(assistantTextDelta(`${" ".repeat(1_024)}"sec\\`), state),
      ...normalizePiEvent(assistantTextDelta("\"ret\" done"), state),
      ...normalizePiEvent(assistantMessage("token=   \"sec\\\"ret\" done"), state),
    ];
    const rendered = events
      .filter((event): event is Extract<AgencyEvent, { type: "assistant_text_delta" }> =>
        event.type === "assistant_text_delta",
      )
      .map(({ delta }) => delta)
      .join("");

    expect(rendered).toBe("token=[REDACTED] done");
    expect(rendered).not.toContain("sec");
    expect(rendered).not.toContain("ret");
  });

  it("inserts final-assembly newlines between streamed text content blocks", () => {
    const state = {
      calls: new Map(),
      changedFiles: new Set<string>(),
      finalMessage: "",
      providerError: undefined,
    };
    const events = [
      ...normalizePiEvent(assistantTextDelta("First block", 0), state),
      ...normalizePiEvent(assistantTextDelta("Second block", 2), state),
      ...normalizePiEvent(assistantMessage("First block\nSecond block"), state),
    ];

    expect(events).toEqual([
      { type: "assistant_text_delta", delta: "First block", done: false },
      { type: "assistant_text_delta", delta: "\nSecond block", done: false },
      { type: "assistant_text_delta", delta: "", done: true },
    ]);

    expect(normalizePiEvent(assistantTextDelta("Next message", 7), state)).toEqual([
      { type: "assistant_text_delta", delta: "Next message", done: false },
    ]);
  });

  it("caps normalized stream chunks and marks only the final flush slice done", () => {
    const state = {
      calls: new Map(),
      changedFiles: new Set<string>(),
      finalMessage: "",
      providerError: undefined,
    };
    const text = "x".repeat(65_541);
    const deltas = normalizePiEvent(assistantTextDelta(text), state);
    const end = normalizePiEvent(assistantMessage(text), state);

    expect(deltas.map((event) => event.type === "assistant_text_delta" && [event.delta.length, event.done]))
      .toEqual([[65_536, false], [5, false]]);
    expect(end).toEqual([{ type: "assistant_text_delta", delta: "", done: true }]);

    const pendingState = {
      calls: new Map(),
      changedFiles: new Set<string>(),
      finalMessage: "",
      providerError: undefined,
    };
    expect(normalizePiEvent(assistantTextDelta("ending s"), pendingState)).toEqual([
      { type: "assistant_text_delta", delta: "ending ", done: false },
    ]);
    expect(normalizePiEvent(assistantMessage("ending s"), pendingState)).toEqual([
      { type: "assistant_text_delta", delta: "s", done: true },
    ]);
  });
});
