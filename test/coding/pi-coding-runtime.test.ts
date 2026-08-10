import { describe, expect, it, vi } from "vitest";

import type {
  AgentSessionEvent,
  CreateAgentSessionOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { AgencyEvent, Plan, RepoContext } from "../../src/domain/index.js";
import { InfrastructureError } from "../../src/process/index.js";
import {
  PiCodingRuntime,
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
  readonly abort = vi.fn(async () => {});
  readonly dispose = vi.fn(() => {});
  readonly prompts: string[] = [];
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  constructor(
    readonly sessionId: string,
    readonly onPrompt: (session: StubSession, prompt: string) => Promise<void>,
  ) {}

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
}) {
  const sessionOptions: CreateAgentSessionOptions[] = [];
  const sessions: StubSession[] = [];
  const submitResults: unknown[] = [];
  const modelRuntime = { runtime: true };
  const inMemoryManager = { manager: "memory" };
  const persistentManager = { manager: "persistent" };
  const sdk: PiSdkBoundary = {
    createModelRuntime: vi.fn(async () => modelRuntime as never),
    inMemorySessionManager: vi.fn(() => inMemoryManager as never),
    createSessionManager: vi.fn(() => persistentManager as never),
    createAgentSession: vi.fn(async (sessionOptionsInput) => {
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
    }),
  };
  return {
    sdk,
    sessionOptions,
    sessions,
    submitResults,
    modelRuntime,
    inMemoryManager,
    persistentManager,
  };
}

describe("PiCodingRuntime", () => {
  it("uses one model runtime and an in-memory read-only planner with submit_plan", async () => {
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
    expect(boundary.sdk.inMemorySessionManager).toHaveBeenCalledWith(repo.rootPath);
    expect(boundary.sessionOptions[0]).toMatchObject({
      cwd: repo.rootPath,
      modelRuntime: boundary.modelRuntime,
      sessionManager: boundary.inMemoryManager,
      tools: ["read", "grep", "find", "ls", "submit_plan"],
    });
    expect(boundary.sessionOptions[0]?.tools).not.toEqual(
      expect.arrayContaining(["bash", "edit", "write"]),
    );
    expect(boundary.sessionOptions[0]?.customTools?.[0]?.name).toBe("submit_plan");
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

    const execution = await runtime.execute({ intent: "Build", repo, plan });
    const repair = await runtime.repair({
      intent: "Build",
      repo,
      plan,
      attempt: 1,
      failure: {
        stage: "verifying",
        message: "One focused test failed",
        cause: "expected true",
        recoverable: true,
      },
    });

    expect(boundary.sdk.createSessionManager).toHaveBeenCalledOnce();
    expect(boundary.sdk.createSessionManager).toHaveBeenCalledWith(
      repo.rootPath,
      "/workspace/agency/.devagency/pi-sessions",
    );
    expect(boundary.sessionOptions[0]).toMatchObject({
      cwd: repo.rootPath,
      modelRuntime: boundary.modelRuntime,
      sessionManager: boundary.persistentManager,
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });
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
  });

  it("maps SDK failures to typed infrastructure failures and aborts active sessions", async () => {
    const boundary = createBoundary({
      executorPrompt: async () => {
        throw new Error("provider offline");
      },
    });
    const runtime = await PiCodingRuntime.create({ sdk: boundary.sdk });

    await expect(runtime.execute({ intent: "Build", repo, plan })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InfrastructureError && error.code === "PI_PROVIDER_REQUEST_FAILED",
    );
    await runtime.abort();
    await runtime.dispose();

    expect(boundary.sessions[0]?.abort).toHaveBeenCalled();
    expect(boundary.sessions[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("surfaces sanitized bounded provider errors from planner and executor events", async () => {
    const secret = "sk-provider-secret";
    const longTail = "x".repeat(4_000);
    const providerError =
      `No API key found for the selected model. Bearer bearer-secret token=${secret} ${longTail}`;
    const boundary = createBoundary({
      plannerPrompt: async (session) => {
        session.emit(providerErrorMessage(providerError));
        throw new Error("provider request rejected after emitting its public error");
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
    const executionError = await runtime.execute({ intent: "Build", repo, plan }).catch((error) => error);

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
});

describe("normalizePiEvent", () => {
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
});
