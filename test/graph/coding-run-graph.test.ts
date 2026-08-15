import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { MemorySaver } from "@langchain/langgraph";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeCodingRuntime } from "../../src/coding/index.js";
import type {
  FailureContext,
  Plan,
  VerificationResult,
} from "../../src/domain/index.js";
import {
  CodingRunStateSchema,
  createCodingRunGraph,
  loadRepositoryInstructions,
  routeAfterVerification,
  type CodingRunGraphDependencies,
} from "../../src/graph/index.js";
import type {
  TrajectoryLifecycleEvent,
  TrajectoryWriter,
} from "../../src/observability/index.js";
import { createSqliteCheckpointPersistence, IncompleteRunRegistry, inspectIncompleteRunRecovery } from "../../src/persistence/index.js";
import { InfrastructureError } from "../../src/process/index.js";
import { EventBus } from "../../src/events/index.js";
import {
  captureGitBaseline,
  getChangedFiles,
  inspectRepository,
} from "../../src/repo/index.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

const plan: Plan = {
  objective: "Change the fixture",
  assumptions: [],
  steps: [{ id: "change", description: "Change fixture.txt" }],
  likelyFiles: ["fixture.txt"],
  verificationStrategy: ["Run tests"],
};

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agency-graph-"));
  directories.push(root);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Agency Test"], { cwd: root });
  await writeFile(join(root, "fixture.txt"), "before\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}

function verification(status: "passed" | "failed"): VerificationResult {
  return {
    status,
    summary: status === "passed" ? "tests passed" : "tests failed",
    commands: [{
      command: "npm",
      args: ["test"],
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: status === "passed" ? 20 : 10,
      timedOut: false,
    }],
  };
}

function skippedVerification(): VerificationResult {
  return { status: "skipped", summary: "No verification commands detected", commands: [] };
}

function dependencies(
  runtime: FakeCodingRuntime,
  results: VerificationResult[],
  root: string,
): CodingRunGraphDependencies {
  return {
    runtime,
    inspectRepository,
    captureGitBaseline,
    getChangedFiles,
    detectVerificationCommands: async () => [
      { name: "test", command: "npm", args: ["test"], required: true },
    ],
    runVerification: vi.fn(async (_commands, _cwd, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      const result = results.shift();
      if (result === undefined) throw new Error("No verification result");
      return result;
    }),
    registry: new IncompleteRunRegistry(root),
  };
}

async function setup(results: VerificationResult[]) {
  const root = await repository();
  const runtime = new FakeCodingRuntime();
  runtime.enqueuePlanResult({ plan, message: "planned" });
  const deps = dependencies(runtime, results, root);
  return { root, runtime, deps, graph: createCodingRunGraph(deps) };
}

function input(root: string, maxRepairAttempts = 2) {
  return {
    runId: "run-001",
    threadId: "thread-001",
    sessionId: "session-001",
    repoPath: root,
    userIntent: "Update the fixture",
    maxRepairAttempts,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("coding run graph", () => {
  it("records exact failed-run model counts without estimating usage", async () => {
    const root = await repository();
    const runtime = new FakeCodingRuntime();
    runtime.enqueuePlanResult(new Error("planner unavailable"));
    runtime.createPlan = async (runtimeInput) => {
      runtimeInput.onEvent?.({ type: "model_turn" });
      return FakeCodingRuntime.prototype.createPlan.call(runtime, runtimeInput);
    };
    const deps = dependencies(runtime, [], root);
    const write = vi.fn(async () => {});
    deps.evaluationStore = { write };

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.status).toBe("failed");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      success: false,
      repairAttempts: 0,
      toolCalls: 0,
      modelCalls: { planner: 1, execute: 0, repair: 0, total: 1 },
      verification: { status: "not-run", commandCount: 0, durationsMs: [] },
      humanDecisionCount: 0,
    }));
    expect(JSON.stringify(write.mock.calls[0]?.[0])).not.toMatch(/tokens?|cost/iu);
  });

  it("refuses mission success when measured Git delta exceeds three files", async () => {
    const { root, runtime, deps } = await setup([]);
    runtime.enqueueExecuteResult({ message: "too broad", changedFiles: [], sessionId: "pi-1" });
    deps.getChangedFiles = async () => ["a", "b", "c", "d"].map((path) => ({ path, status: "added" as const }));
    const write = vi.fn(async () => {});
    deps.evaluationStore = { write };

    const state = await createCodingRunGraph(deps).invoke({ ...input(root), missionKind: "simplify" });

    expect(state).toMatchObject({
      status: "failed",
      changedFiles: ["a", "b", "c", "d"],
      failure: { stage: "executing", recoverable: false },
    });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      changedFileCount: 4,
      mission: "simplify",
    }));
    expect(deps.runVerification).not.toHaveBeenCalled();
  });

  it("seeds mission runtime budget from authoritative Git delta before reentry", async () => {
    const { root, runtime, deps } = await setup([verification("passed")]);
    runtime.enqueueExecuteResult({ message: "bounded", changedFiles: [], sessionId: "pi-1" });
    deps.getChangedFiles = async () => ["a", "b", "c"].map((path) => ({ path, status: "added" as const }));
    await createCodingRunGraph(deps).invoke({ ...input(root), missionKind: "tests" });
    expect(runtime.calls.execute[0]?.missionPolicy).toEqual({
      budgetId: "run-001",
      maxChangedFiles: 3,
      changedPaths: ["a", "b", "c"],
    });
  });

  it("persists deduplicated proposals only after verification passes", async () => {
    const { root, runtime, deps } = await setup([verification("passed")]);
    const trajectory: Array<Parameters<TrajectoryWriter["append"]>[0]> = [];
    deps.trajectoryWriter = { append: async (event) => { trajectory.push(event); } };
    const append = vi.fn(async (entries) => ({ entries: [...entries] }));
    deps.knowledgeStore = { load: async () => ({ entries: [] }), append };
    runtime.enqueueExecuteResult({
      message: "done", changedFiles: [], sessionId: "pi-1",
      proposedKnowledge: [
        { category: "decision", text: "Use SQLite." },
        { category: "decision", text: "use sqlite." },
      ],
    });
    const state = await createCodingRunGraph(deps).invoke(input(root));
    expect(state.status).toBe("completed");
    expect(append).toHaveBeenCalledWith([{ category: "decision", text: "Use SQLite." }]);
    const executionEvent = trajectory.find(({ event }) => event === "execution_completed");
    expect(executionEvent?.metadata).toMatchObject({ knowledgeProposalCount: 2, knowledgeCategories: ["decision"] });
    expect(JSON.stringify(executionEvent)).not.toContain("SQLite");

    const failed = await setup([verification("failed")]);
    const failedAppend = vi.fn();
    failed.deps.knowledgeStore = { load: async () => ({ entries: [] }), append: failedAppend };
    failed.runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-2", proposedKnowledge: [{ category: "learning", text: "Never persist me." }] });
    failed.runtime.enqueueRepairResult({ message: "repair", changedFiles: [], sessionId: "pi-2" });
    await createCodingRunGraph(failed.deps).invoke(input(failed.root, 1));
    expect(failedAppend).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps finalization recoverable and discoverable when knowledge persistence fails", async () => {
    const { root, runtime, deps } = await setup([verification("passed")]);
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1", proposedKnowledge: [{ category: "learning", text: "A fact." }] });
    const append = vi.fn()
      .mockRejectedValueOnce(new InfrastructureError("METADATA_WRITE_FAILED", "knowledge unavailable"))
      .mockResolvedValue({ entries: [{ category: "learning", text: "A fact." }] });
    deps.knowledgeStore = {
      load: async () => ({ entries: [] }),
      append,
    };
    const persistence = await createSqliteCheckpointPersistence(root);
    const trajectory: TrajectoryLifecycleEvent[] = [];
    deps.trajectoryWriter = { append: async ({ event }) => { trajectory.push(event); } };
    const graph = createCodingRunGraph(deps, { checkpointer: persistence.checkpointer });

    await expect(graph.invoke(input(root))).rejects.toThrow("knowledge unavailable");
    const snapshot = await graph.getState("thread-001");
    expect(snapshot).toMatchObject({
      values: { runId: "run-001", status: "verifying", failure: null },
      next: ["summarize"],
    });
    await expect(deps.registry.list()).resolves.toMatchObject([{ runId: "run-001" }]);
    await expect(inspectIncompleteRunRecovery(deps.registry, graph)).resolves.toMatchObject([
      { status: "resumable", entry: { runId: "run-001" } },
    ]);

    await expect(graph.resume("thread-001")).resolves.toMatchObject({ status: "completed" });
    expect(append).toHaveBeenCalledTimes(2);
    expect(trajectory.filter((event) => event === "run_completed")).toHaveLength(1);
    await expect(deps.registry.list()).resolves.toEqual([]);
    persistence.close();
  });
  it("keeps evaluation persistence failure recoverable at finalization", async () => {
    const { root, runtime, deps } = await setup([verification("passed")]);
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });
    const write = vi.fn()
      .mockRejectedValueOnce(new InfrastructureError("METADATA_WRITE_FAILED", "evaluations unavailable"))
      .mockResolvedValue(undefined);
    deps.evaluationStore = { write };
    const persistence = await createSqliteCheckpointPersistence(root);
    const graph = createCodingRunGraph(deps, { checkpointer: persistence.checkpointer });

    await expect(graph.invoke(input(root))).rejects.toThrow("evaluations unavailable");
    await expect(graph.getState("thread-001")).resolves.toMatchObject({
      values: { runId: "run-001", status: "verifying", failure: null },
      next: ["summarize"],
    });
    await expect(inspectIncompleteRunRecovery(deps.registry, graph)).resolves.toMatchObject([
      { status: "resumable", entry: { runId: "run-001" } },
    ]);
    await expect(graph.resume("thread-001")).resolves.toMatchObject({ status: "completed" });
    expect(write).toHaveBeenCalledTimes(2);
    persistence.close();
  });
  it("checkpoints a human request and resumes without duplicating execution", async () => {
    const { root, runtime, deps } = await setup([verification("passed")]);
    const request = {
      id: "approve-migration-1",
      kind: "approval" as const,
      question: "Approve this database migration?",
      risk: "It changes the database schema.",
      action: "npx prisma migrate deploy",
      options: [
        { id: "approve", label: "Approve", description: "Run this exact action once." },
        { id: "reject", label: "Reject", description: "Cancel this action." },
        {
          id: "edit",
          label: "Edit",
          description: "Provide different guidance; do not run the original action.",
        },
      ],
      allowCustom: true,
    };
    runtime.enqueueExecuteResult({ decisionRequest: request, message: "approval needed" });
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });
    const trajectory: Array<Parameters<TrajectoryWriter["append"]>[0]> = [];
    deps.trajectoryWriter = { append: async (event) => { trajectory.push(event); } };
    const runner = createCodingRunGraph(deps, { checkpointer: new MemorySaver() });

    const interrupted = await runner.invoke(input(root), { threadId: "human-thread" });

    expect(interrupted.pendingHumanDecision).toEqual(request);
    expect(runtime.calls.execute).toHaveLength(1);
    await expect(runner.getState("human-thread")).resolves.toMatchObject({
      values: { pendingHumanDecision: request, status: "executing" },
      next: ["human"],
    });

    const completed = await runner.resume("human-thread", {
      requestId: request.id,
      optionId: "approve",
    });

    expect(completed.status).toBe("completed");
    expect(runtime.calls.execute).toHaveLength(2);
    expect(runtime.calls.execute[1]?.humanDecision).toEqual({
      request,
      response: { requestId: request.id, optionId: "approve" },
    });
    expect(trajectory.filter(({ event }) => event === "human_input_requested")).toHaveLength(1);
    expect(trajectory.filter(({ event }) => event === "human_input_resolved")).toHaveLength(1);
    expect(trajectory.filter(({ event }) => event === "execution_started")).toHaveLength(1);
    expect(trajectory.find(({ event }) => event === "human_input_requested")?.metadata).toEqual({
      requestId: request.id,
      decisionKind: "approval",
      optionCount: 3,
    });
    expect(trajectory.find(({ event }) => event === "human_input_resolved")?.metadata).toEqual({
      requestId: request.id,
      resolution: "option",
    });
    expect(JSON.stringify(trajectory)).not.toContain(request.question);
    expect(JSON.stringify(trajectory)).not.toContain("Approve");
  });

  it("finalizes cancellation exactly once and retries evaluation persistence", async () => {
    const { root, runtime, deps } = await setup([]);
    const request = {
      id: "cancel-choice",
      kind: "clarification" as const,
      question: "Continue?",
      options: [
        { id: "yes", label: "Yes", description: "Continue." },
        { id: "no", label: "No", description: "Stop." },
      ],
      allowCustom: true,
    };
    runtime.enqueueExecuteResult({ decisionRequest: request, message: "waiting" });
    const write = vi.fn()
      .mockRejectedValueOnce(new InfrastructureError("METADATA_WRITE_FAILED", "evaluation unavailable"))
      .mockResolvedValue(undefined);
    deps.evaluationStore = { write };
    const trajectory: Array<Parameters<TrajectoryWriter["append"]>[0]> = [];
    deps.trajectoryWriter = { append: async (event) => { trajectory.push(event); } };
    const graph = createCodingRunGraph(deps, { checkpointer: new MemorySaver() });
    await graph.invoke({ ...input(root), threadId: "cancel-thread" }, { threadId: "cancel-thread" });

    await expect(graph.cancel?.("cancel-thread")).rejects.toThrow("evaluation unavailable");
    await expect(inspectIncompleteRunRecovery(deps.registry, graph)).resolves.toMatchObject([
      { status: "resumable", entry: { runId: "run-001" } },
    ]);
    const cancelled = await graph.cancel?.("cancel-thread");
    expect(cancelled).toMatchObject({ status: "cancelled", changedFiles: [] });
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "cancelled",
      success: false,
      changedFileCount: 0,
    }));
    await graph.cancel?.("cancel-thread");
    expect(write).toHaveBeenCalledTimes(2);
    expect(trajectory.filter(({ event }) => event === "run_completed")).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ status: "cancelled" }) }),
    ]);
    await expect(deps.registry.list()).resolves.toEqual([]);
  });

  it("persists live execute metrics during abort cancellation", async () => {
    const { root, runtime, deps } = await setup([]);
    let started!: () => void;
    const executing = new Promise<void>((resolve) => { started = resolve; });
    runtime.execute = async (runtimeInput) => {
      runtimeInput.onEvent?.({ type: "model_turn" });
      runtimeInput.onEvent?.({ type: "tool", tool: "read" });
      started();
      await new Promise<void>((_resolve, reject) => runtimeInput.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      ));
      throw new Error("unreachable");
    };
    const write = vi.fn(async () => {});
    deps.evaluationStore = { write };
    const graph = createCodingRunGraph(deps, { checkpointer: new MemorySaver() });
    const controller = new AbortController();
    const invoking = graph.invoke(
      { ...input(root), threadId: "live-cancel" },
      { threadId: "live-cancel", signal: controller.signal },
    ).catch(() => undefined);
    await executing;
    controller.abort();
    await invoking;

    await graph.cancel?.("live-cancel");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      status: "cancelled",
      toolCalls: 1,
      modelCalls: { planner: 0, execute: 1, repair: 0, total: 1 },
    }));
  });

  it("routes a planning response from the checkpointed planning status", async () => {
    const root = await repository();
    const runtime = new FakeCodingRuntime();
    const request = {
      id: "plan-choice",
      kind: "clarification" as const,
      question: "Which plan should be used?",
      options: [
        { id: "small", label: "Small", description: "Use the narrow plan." },
        { id: "broad", label: "Broad", description: "Use the broader plan." },
      ],
      allowCustom: true,
    };
    runtime.enqueuePlanResult({ decisionRequest: request, message: "choice needed" });
    runtime.enqueuePlanResult({ plan, message: "planned" });
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });
    const runner = createCodingRunGraph(
      dependencies(runtime, [verification("passed")], root),
      { checkpointer: new MemorySaver() },
    );

    const paused = await runner.invoke(input(root), { threadId: "plan-pause" });
    expect(paused).toMatchObject({ status: "planning", pendingHumanDecision: request });

    const completed = await runner.resume("plan-pause", {
      requestId: request.id,
      optionId: "small",
    });

    expect(completed.status).toBe("completed");
    expect(runtime.calls.createPlan).toHaveLength(2);
    expect(runtime.calls.createPlan[1]?.humanDecision?.response).toEqual({
      requestId: request.id,
      optionId: "small",
    });
  }, 10_000);

  it("counts a paused repair exactly once after it completes", async () => {
    const { root, runtime, deps } = await setup([
      verification("failed"),
      verification("failed"),
      verification("passed"),
    ]);
    const request = {
      id: "repair-choice",
      kind: "clarification" as const,
      question: "Which repair should be applied?",
      options: [
        { id: "small", label: "Small", description: "Apply the narrow repair." },
        { id: "broad", label: "Broad", description: "Apply the broader repair." },
      ],
      allowCustom: true,
    };
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });
    runtime.enqueueRepairResult({ decisionRequest: request, message: "choice needed" });
    runtime.enqueueRepairResult({ message: "first repair", changedFiles: [], sessionId: "pi-1" });
    runtime.enqueueRepairResult({ message: "second repair", changedFiles: [], sessionId: "pi-1" });
    runtime.createPlan = async (runtimeInput) => {
      runtimeInput.onEvent?.({ type: "model_turn" });
      runtimeInput.onEvent?.({ type: "tool", tool: "read" });
      return FakeCodingRuntime.prototype.createPlan.call(runtime, runtimeInput);
    };
    runtime.execute = async (runtimeInput) => {
      runtimeInput.onEvent?.({ type: "model_turn" });
      runtimeInput.onEvent?.({ type: "model_turn" });
      runtimeInput.onEvent?.({ type: "tool", tool: "read" });
      runtimeInput.onEvent?.({ type: "tool", tool: "edit" });
      return FakeCodingRuntime.prototype.execute.call(runtime, runtimeInput);
    };
    runtime.repair = async (runtimeInput) => {
      runtimeInput.onEvent?.({ type: "model_turn" });
      runtimeInput.onEvent?.({ type: "tool", tool: "repair" });
      return FakeCodingRuntime.prototype.repair.call(runtime, runtimeInput);
    };
    const writeEvaluation = vi.fn(async () => {});
    deps.evaluationStore = { write: writeEvaluation };
    const runner = createCodingRunGraph(deps, { checkpointer: new MemorySaver() });

    const paused = await runner.invoke({ ...input(root, 2), missionKind: "tests" }, { threadId: "repair-pause" });
    expect(paused.attempt).toBe(0);

    const completed = await runner.resume("repair-pause", {
      requestId: request.id,
      optionId: "small",
    });

    expect(completed.status).toBe("completed");
    expect(completed.attempt).toBe(2);
    expect(runtime.calls.repair.map(({ attempt }) => attempt)).toEqual([1, 1, 2]);
    expect(writeEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      runId: "run-001",
      status: "completed",
      success: true,
      repairAttempts: 2,
      toolCalls: 6,
      modelCalls: { planner: 1, execute: 2, repair: 3, total: 6 },
      humanDecisionCount: 1,
      mission: "tests",
      verification: { status: "passed", commandCount: 3, durationsMs: [10, 10, 20] },
    }));
  }, 10_000);

  it("redacts a human response before constructing the persisted resume command", async () => {
    const { root, runtime, deps } = await setup([verification("passed")]);
    const request = {
      id: "secret-guidance",
      kind: "clarification" as const,
      question: "What guidance should be used?",
      options: [
        { id: "one", label: "One", description: "Use option one." },
        { id: "two", label: "Two", description: "Use option two." },
      ],
      allowCustom: true,
    };
    runtime.enqueueExecuteResult({ decisionRequest: request, message: "guidance needed" });
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });
    const persistence = await createSqliteCheckpointPersistence(root);
    const runner = createCodingRunGraph(deps, { checkpointer: persistence.checkpointer });
    await runner.invoke(input(root), { threadId: "secret-resume" });

    await runner.resume("secret-resume", {
      requestId: request.id,
      customText: "token=super-secret continue safely",
    });
    expect(runtime.calls.execute[1]?.humanDecision?.response.customText).toBe(
      "token=[REDACTED] continue safely",
    );
    await expect(runner.resume("missing-request", {
      requestId: request.id,
      optionId: "one",
    })).rejects.toThrow("matching pending human request");
    persistence.close();
    expect((await readFile(persistence.path)).includes(Buffer.from("super-secret"))).toBe(false);
  });

  it("records the successful lifecycle in order without UI event payloads", async () => {
    const { root, runtime, deps } = await setup([verification("passed")]);
    const events: TrajectoryLifecycleEvent[] = [];
    deps.trajectoryWriter = {
      append: async (event) => {
        events.push(event.event);
      },
    } satisfies TrajectoryWriter;
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.status).toBe("completed");
    expect(events).toEqual([
      "run_started",
      "prepare_started",
      "prepare_completed",
      "plan_started",
      "plan_completed",
      "execution_started",
      "execution_completed",
      "verification_started",
      "verification_passed",
      "verification_completed",
      "run_completed",
    ]);
  });

  it("records failed verification and repair lifecycles in order", async () => {
    const { root, runtime, deps } = await setup([
      verification("failed"),
      verification("passed"),
    ]);
    const events: TrajectoryLifecycleEvent[] = [];
    deps.trajectoryWriter = {
      append: async (event) => {
        events.push(event.event);
      },
    } satisfies TrajectoryWriter;
    runtime.enqueueExecuteResult({ message: "broken", changedFiles: [], sessionId: "pi-1" });
    runtime.enqueueRepairResult({ message: "fixed", changedFiles: [], sessionId: "pi-1" });

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.status).toBe("completed");
    expect(events).toEqual([
      "run_started",
      "prepare_started",
      "prepare_completed",
      "plan_started",
      "plan_completed",
      "execution_started",
      "execution_completed",
      "verification_started",
      "verification_failed",
      "verification_completed",
      "repair_started",
      "repair_completed",
      "verification_started",
      "verification_passed",
      "verification_completed",
      "run_completed",
    ]);
  }, 10_000);

  it("treats trajectory write failures as infrastructure failures, never repair input", async () => {
    const { root, runtime, deps } = await setup([]);
    deps.trajectoryWriter = {
      append: async () => {
        throw new InfrastructureError(
          "TRAJECTORY_WRITE_FAILED",
          "Could not persist trajectory",
        );
      },
    };

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.status).toBe("failed");
    expect(state.failure).toMatchObject({
      recoverable: false,
      message: "Could not persist trajectory",
    });
    expect(runtime.calls.repair).toHaveLength(0);
  });

  it("runs prepare through summarize on success and clears incomplete metadata", async () => {
    const { root, runtime, graph } = await setup([verification("passed")]);
    runtime.enqueueExecuteResult({ message: "done", changedFiles: ["fake.txt"], sessionId: "pi-1" });
    runtime.execute = async (executeInput) => {
      const result = await FakeCodingRuntime.prototype.execute.call(runtime, executeInput);
      await writeFile(join(root, "fixture.txt"), "after\n");
      return result;
    };

    const state = await graph.invoke(input(root));

    expect(state.status).toBe("completed");
    expect(state.changedFiles).toEqual(["fixture.txt"]);
    expect(state.sessionId).toBe("session-001");
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    await expect(new IncompleteRunRegistry(root).list()).resolves.toEqual([]);
  });

  it("loads repository instructions into state and every coding runtime phase", async () => {
    const root = await repository();
    await writeFile(join(root, "AGENTS.md"), "Use fixture conventions.\n");
    const runtime = new FakeCodingRuntime();
    runtime.enqueuePlanResult({ plan, message: "planned" });
    runtime.enqueueExecuteResult({ message: "broken", changedFiles: [], sessionId: "pi-1" });
    runtime.enqueueRepairResult({ message: "fixed", changedFiles: [], sessionId: "pi-1" });
    const deps = dependencies(runtime, [verification("failed"), verification("passed")], root);
    const knowledge = {
      entries: [{ category: "architecture" as const, text: "The graph owns verification." }],
    };
    deps.knowledgeStore = { load: async () => knowledge, append: async () => knowledge };
    const graph = createCodingRunGraph(deps);

    const state = await graph.invoke(input(root));

    expect(state.repoInstructions).toBe("[AGENTS.md]\nUse fixture conventions.");
    expect(runtime.calls.createPlan[0]?.repoInstructions).toBe(state.repoInstructions);
    expect(runtime.calls.execute[0]?.repoInstructions).toBe(state.repoInstructions);
    expect(runtime.calls.repair[0]?.repoInstructions).toBe(state.repoInstructions);
    expect(state.projectKnowledge).toEqual(knowledge);
    expect(runtime.calls.createPlan[0]?.projectKnowledge).toEqual(knowledge);
    expect(runtime.calls.execute[0]?.projectKnowledge).toEqual(knowledge);
    expect(runtime.calls.repair[0]?.projectKnowledge).toEqual(knowledge);
  });

  it("keeps repository instructions within runtime prompt contract", async () => {
    const root = await repository();
    const file = join(root, "AGENTS.md");
    await writeFile(file, "x".repeat(7_000));

    const instructions = await loadRepositoryInstructions(root, [file]);

    expect(instructions).toHaveLength(6_000);
    expect(instructions).toMatch(/^\[AGENTS\.md\]\n/u);
  });

  it("rejects linked and outside repository instruction reads", async () => {
    const root = await repository();
    const outside = await mkdtemp(join(tmpdir(), "agency-instructions-outside-"));
    directories.push(outside);
    const external = join(outside, "AGENTS.md");
    await writeFile(external, "outside\n");
    const linked = join(root, "AGENTS.md");
    await symlink(external, linked);
    await expect(loadRepositoryInstructions(root, [linked])).rejects.toMatchObject({
      code: "METADATA_READ_FAILED",
    });
    await rm(linked);
    await link(external, linked);
    await expect(loadRepositoryInstructions(root, [linked])).rejects.toMatchObject({
      code: "METADATA_READ_FAILED",
    });
    await expect(loadRepositoryInstructions(root, [external])).rejects.toMatchObject({
      code: "METADATA_READ_FAILED",
    });
  });

  it("repairs a coding verification failure and then succeeds", async () => {
    const { root, runtime, graph } = await setup([
      verification("failed"),
      verification("passed"),
    ]);
    runtime.enqueueExecuteResult({ message: "broken", changedFiles: [], sessionId: "pi-1" });
    runtime.enqueueRepairResult({ message: "fixed", changedFiles: [], sessionId: "pi-1" });

    const state = await graph.invoke(input(root));

    expect(state.status).toBe("completed");
    expect(state.attempt).toBe(1);
    expect(runtime.calls.repair).toHaveLength(1);
    expect(runtime.calls.repair[0]?.failure.recoverable).toBe(true);
  });

  it("remeasures and owns only newly visible paths created by verification", async () => {
    const { root, runtime, deps } = await setup([]);
    const bus = new EventBus();
    const ownedPaths: string[] = [];
    bus.subscribe("file_changed", ({ path }) => ownedPaths.push(path));
    deps.eventBus = bus;
    deps.runVerification = vi.fn(async () => {
      await writeFile(join(root, "verification-output.txt"), "generated\n");
      return verification("passed");
    });
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.status).toBe("completed");
    expect(state.changedFiles).toEqual(["verification-output.txt"]);
    expect(ownedPaths).toEqual(["verification-output.txt"]);
  });

  it("remeasures a failed verification before routing its new path to repair", async () => {
    const { root, runtime, deps } = await setup([]);
    let verificationAttempt = 0;
    deps.runVerification = vi.fn(async () => {
      verificationAttempt += 1;
      if (verificationAttempt === 1) {
        await writeFile(join(root, "failed-verification.txt"), "failure artifact\n");
        return verification("failed");
      }
      return verification("passed");
    });
    runtime.enqueueExecuteResult({ message: "broken", changedFiles: [], sessionId: "pi-1" });
    runtime.enqueueRepairResult({ message: "fixed", changedFiles: [], sessionId: "pi-1" });

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(runtime.calls.repair[0]?.changedFiles).toEqual(["failed-verification.txt"]);
    expect(state.changedFiles).toEqual(["failed-verification.txt"]);
    expect(state.status).toBe("completed");
  });

  it("does not claim verifier ownership of a path already dirty before verification", async () => {
    const { root, runtime, deps } = await setup([]);
    const bus = new EventBus();
    const ownedPaths: string[] = [];
    bus.subscribe("file_changed", ({ path }) => ownedPaths.push(path));
    deps.eventBus = bus;
    runtime.enqueueExecuteResult({ message: "dirty", changedFiles: [], sessionId: "pi-1" });
    runtime.execute = async (executeInput) => {
      const result = await FakeCodingRuntime.prototype.execute.call(runtime, executeInput);
      await writeFile(join(root, "fixture.txt"), "executor value\n");
      return result;
    };
    deps.runVerification = vi.fn(async () => {
      await writeFile(join(root, "fixture.txt"), "verifier value\n");
      return verification("passed");
    });

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.changedFiles).toEqual(["fixture.txt"]);
    expect(ownedPaths).toEqual([]);
  });

  it("sanitizes failed verification output before state and repair input", async () => {
    const { root, runtime, deps } = await setup([]);
    const rawSecrets = [
      "Bearer bearer-secret-value",
      "sk-providerSecret123",
      "token=plain-token-value",
      "password=hunter2",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
    ];
    deps.runVerification = vi.fn(async () => ({
      ...verification("failed"),
      commands: [{
        ...verification("failed").commands[0]!,
        stdout: rawSecrets.join("\n"),
        stderr: rawSecrets.join("\n"),
      }],
    }));
    runtime.enqueueExecuteResult({ message: "broken", changedFiles: [], sessionId: "pi-1" });
    runtime.enqueueRepairResult({ message: "fixed", changedFiles: [], sessionId: "pi-1" });
    const persistence = await createSqliteCheckpointPersistence(root);

    const state = await createCodingRunGraph(deps, {
      checkpointer: persistence.checkpointer,
    }).invoke(input(root));

    const persistedBoundary = JSON.stringify({ verification: state.verification, repair: runtime.calls.repair[0] });
    for (const secret of rawSecrets) expect(persistedBoundary).not.toContain(secret);
    expect(persistedBoundary).toContain("[REDACTED]");
    persistence.close();
    const checkpointBytes = await readFile(persistence.path);
    for (const secret of rawSecrets) {
      expect(checkpointBytes.includes(Buffer.from(secret))).toBe(false);
    }
  });

  it("sanitizes verifier infrastructure errors before checkpoint state", async () => {
    const { root, runtime, deps } = await setup([]);
    deps.runVerification = vi.fn(async () => {
      throw new Error("verifier crashed with Bearer bearer-secret-value");
    });
    runtime.enqueueExecuteResult({ message: "ready", changedFiles: [], sessionId: "pi-1" });

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.failure?.message).toContain("Bearer [REDACTED]");
    expect(JSON.stringify(state)).not.toContain("bearer-secret-value");
  });

  it("fails a mission when verification creates a fourth changed path", async () => {
    const { root, runtime, deps } = await setup([]);
    runtime.enqueueExecuteResult({ message: "three files", changedFiles: [], sessionId: "pi-1" });
    runtime.execute = async (executeInput) => {
      const result = await FakeCodingRuntime.prototype.execute.call(runtime, executeInput);
      await Promise.all(["one.txt", "two.txt", "three.txt"].map(async (path) =>
        await writeFile(join(root, path), `${path}\n`)));
      return result;
    };
    deps.runVerification = vi.fn(async () => {
      await writeFile(join(root, "four.txt"), "four\n");
      return verification("passed");
    });
    const writeEvaluation = vi.fn(async () => {});
    deps.evaluationStore = { write: writeEvaluation };

    const state = await createCodingRunGraph(deps).invoke({ ...input(root), missionKind: "tests" });

    expect(state).toMatchObject({
      status: "failed",
      changedFiles: ["four.txt", "one.txt", "three.txt", "two.txt"],
      failure: { stage: "verifying", recoverable: false },
    });
    expect(state.failure?.message).toContain("more than 3 files");
    expect(runtime.calls.repair).toHaveLength(0);
    expect(writeEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      changedFileCount: 4,
    }));
  });

  it("detects verification before model edits and reuses the immutable commands for every pass", async () => {
    const { root, runtime, deps } = await setup([
      verification("failed"),
      verification("passed"),
    ]);
    const originalCommands = [
      { name: "test", command: "npm", args: ["run", "test"], required: true },
    ];
    const detect = vi.fn(async () => originalCommands);
    const observed: unknown[] = [];
    deps.detectVerificationCommands = detect;
    deps.runVerification = vi.fn(async (commands) => {
      observed.push(commands);
      const result = [verification("failed"), verification("passed")][observed.length - 1];
      if (result === undefined) throw new Error("unexpected verification pass");
      return result;
    });
    runtime.enqueueExecuteResult({ message: "broken", changedFiles: [], sessionId: "pi-1" });
    runtime.enqueueRepairResult({ message: "fixed", changedFiles: [], sessionId: "pi-1" });

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.status).toBe("completed");
    expect(detect).toHaveBeenCalledTimes(1);
    expect(runtime.calls.createPlan).toHaveLength(1);
    expect(state.verificationCommands).toEqual(originalCommands);
    expect(observed).toEqual([originalCommands, originalCommands]);
    expect(observed[0]).not.toBe(originalCommands);
  });

  it("rejects weakened verification scripts instead of accepting a green result", async () => {
    const { root, runtime, deps } = await setup([verification("passed")]);
    deps.detectVerificationCommands = async () => [
      { name: "test", command: "npm", args: ["run", "test"], required: true },
    ];
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { test: "node --test" },
    }));
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });
    runtime.execute = async (executeInput) => {
      const result = await FakeCodingRuntime.prototype.execute.call(runtime, executeInput);
      await writeFile(join(root, "package.json"), JSON.stringify({
        scripts: { test: "node -e true" },
      }));
      return result;
    };

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.status).toBe("failed");
    expect(state.failure).toMatchObject({
      stage: "verifying",
      recoverable: false,
    });
    expect(state.failure?.message).toContain("changed after preparation");
    expect(deps.runVerification).not.toHaveBeenCalled();
    expect(runtime.calls.repair).toHaveLength(0);
  });

  it("fails without repair when verification is skipped", async () => {
    const { root, runtime, deps } = await setup([skippedVerification()]);
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.status).toBe("failed");
    expect(state.verification?.status).toBe("skipped");
    expect(state.failure).toMatchObject({
      stage: "verifying",
      recoverable: false,
      message: "No verification commands detected",
    });
    expect(runtime.calls.repair).toHaveLength(0);
  });

  it("fails clearly when prepare detects no verification commands", async () => {
    const { root, runtime, deps } = await setup([]);
    deps.detectVerificationCommands = vi.fn(async () => []);

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.status).toBe("failed");
    expect(state.summary).toContain("No verification commands detected before model execution");
    expect(state.verification?.status).toBe("skipped");
    expect(runtime.calls.createPlan).toHaveLength(0);
    expect(runtime.calls.execute).toHaveLength(0);
    expect(runtime.calls.repair).toHaveLength(0);
  });

  it("forwards runtime events to the shared event bus exactly once", async () => {
    const { root, runtime, deps } = await setup([
      verification("failed"),
      verification("passed"),
    ]);
    const bus = new EventBus();
    const messages: string[] = [];
    const phases: string[] = [];
    bus.subscribe("message", ({ content }) => messages.push(content));
    bus.subscribe("phase", ({ phase }) => phases.push(phase));
    deps.eventBus = bus;
    runtime.enqueuePlanResult({ plan, message: "planned again" });
    runtime.createPlan = async (planInput) => {
      planInput.onEvent?.({ type: "phase", phase: "planning" });
      planInput.onEvent?.({ type: "message", content: "plan event" });
      return FakeCodingRuntime.prototype.createPlan.call(runtime, planInput);
    };
    runtime.enqueueExecuteResult({ message: "broken", changedFiles: [], sessionId: "pi-1" });
    runtime.execute = async (executeInput) => {
      executeInput.onEvent?.({ type: "phase", phase: "executing" });
      executeInput.onEvent?.({ type: "message", content: "execute event" });
      return FakeCodingRuntime.prototype.execute.call(runtime, executeInput);
    };
    runtime.enqueueRepairResult({ message: "fixed", changedFiles: [], sessionId: "pi-1" });
    runtime.repair = async (repairInput) => {
      repairInput.onEvent?.({ type: "phase", phase: "repairing" });
      repairInput.onEvent?.({ type: "message", content: "repair event" });
      return FakeCodingRuntime.prototype.repair.call(runtime, repairInput);
    };

    await createCodingRunGraph(deps).invoke(input(root));

    expect(messages).toEqual(["plan event", "execute event", "repair event"]);
    expect(phases.filter((phase) => phase === "planning")).toHaveLength(1);
    expect(phases.filter((phase) => phase === "executing")).toHaveLength(1);
    expect(phases.filter((phase) => phase === "repairing")).toHaveLength(1);
  });

  it("exhausts exactly the configured two repair attempts", async () => {
    const { root, runtime, graph } = await setup([
      verification("failed"),
      verification("failed"),
      verification("failed"),
    ]);
    runtime.enqueueExecuteResult({ message: "broken", changedFiles: [], sessionId: "pi-1" });
    runtime.enqueueRepairResult({ message: "still broken", changedFiles: [], sessionId: "pi-1" });
    runtime.enqueueRepairResult({ message: "still broken", changedFiles: [], sessionId: "pi-1" });

    const state = await graph.invoke(input(root, 2));

    expect(state.status).toBe("failed");
    expect(state.attempt).toBe(2);
    expect(runtime.calls.repair).toHaveLength(2);
    expect(state.summary).toContain("2 repair attempts");
  });

  it("does not repair infrastructure failures", async () => {
    const { root, runtime, graph } = await setup([]);
    runtime.enqueueExecuteResult(new Error("Pi process could not start"));

    const state = await graph.invoke(input(root));

    expect(state.status).toBe("failed");
    expect(state.failure).toMatchObject({
      stage: "executing",
      recoverable: false,
      message: "Pi process could not start",
    });
    expect(state.summary).toContain("Pi process could not start");
    expect(runtime.calls.repair).toHaveLength(0);
  });

  it("reports terminal metadata failures at the truthful finalizing stage", async () => {
    const { root, runtime, deps } = await setup([verification("passed")]);
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });
    const registry = deps.registry;
    const finalizationOrder: string[] = [];
    deps.trajectoryWriter = {
      append: async ({ event }) => {
        if (event === "run_completed") finalizationOrder.push("trajectory");
      },
    };
    deps.registry = {
      upsert: (entry) => registry.upsert(entry),
      updateStatus: async (runId, status, updatedAt) => {
        if (status === "completed") {
          finalizationOrder.push("registry");
          throw new Error("registry unavailable");
        }
        await registry.updateStatus(runId, status, updatedAt);
      },
    };

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.status).toBe("failed");
    expect(state.failure).toMatchObject({
      stage: "finalizing",
      recoverable: false,
      message: "registry unavailable",
    });
    expect(finalizationOrder).toEqual(["trajectory", "registry"]);
    await expect(registry.list()).resolves.toMatchObject([{ runId: "run-001" }]);
  });

  it("keeps incomplete metadata discoverable when final trajectory logging fails", async () => {
    const { root, runtime, deps } = await setup([verification("passed")]);
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });
    const registry = deps.registry;
    const updateStatus = vi.spyOn(registry, "updateStatus");
    deps.trajectoryWriter = {
      append: async ({ event }) => {
        if (event === "run_completed") throw new Error("trajectory unavailable");
      },
    };

    const state = await createCodingRunGraph(deps).invoke(input(root));

    expect(state.status).toBe("failed");
    expect(state.failure).toMatchObject({
      stage: "finalizing",
      recoverable: false,
      message: "trajectory unavailable",
    });
    expect(updateStatus).not.toHaveBeenCalledWith(
      "run-001",
      "completed",
      expect.any(String),
    );
    await expect(registry.list()).resolves.toMatchObject([{ runId: "run-001" }]);
  });

  it("uses actual Git changes instead of a coding runtime report", async () => {
    const { root, runtime, graph } = await setup([verification("passed")]);
    runtime.enqueueExecuteResult({
      message: "done",
      changedFiles: ["hallucinated.ts"],
      sessionId: "pi-1",
    });
    runtime.execute = async (executeInput) => {
      const result = await FakeCodingRuntime.prototype.execute.call(runtime, executeInput);
      await writeFile(join(root, "real-change.ts"), "export {};\n");
      return result;
    };

    const state = await graph.invoke(input(root));

    expect(state.changedFiles).toEqual(["real-change.ts"]);
  });

  it("excludes only the complete .devagency metadata subtree from Git changes", async () => {
    const { root, runtime, graph } = await setup([verification("passed")]);
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });
    runtime.execute = async (executeInput) => {
      const result = await FakeCodingRuntime.prototype.execute.call(runtime, executeInput);
      await mkdir(join(root, ".devagency", "pi", "sessions"), { recursive: true });
      await mkdir(join(root, ".devagency-other"), { recursive: true });
      await writeFile(join(root, ".devagency", "session.json"), "{}\n");
      await writeFile(join(root, ".devagency", "pi", "sessions", "run.json"), "{}\n");
      await writeFile(join(root, ".devagency-other", "real.json"), "{}\n");
      await writeFile(join(root, "real-change.ts"), "export {};\n");
      return result;
    };

    const state = await graph.invoke(input(root));

    expect(state.changedFiles).toEqual([".devagency-other/real.json", "real-change.ts"]);
  });

  it("exposes serializable state, pure routing, state lookup, and a resume seam", async () => {
    const { root, runtime, deps } = await setup([verification("passed")]);
    runtime.enqueueExecuteResult({ message: "done", changedFiles: [], sessionId: "pi-1" });
    const runner = createCodingRunGraph(deps, { checkpointer: new MemorySaver() });
    const completed = await runner.invoke(input(root), { threadId: "checkpoint-thread" });

    await expect(CodingRunStateSchema.validateInput(completed)).resolves.toEqual(completed);
    expect(routeAfterVerification(completed)).toBe("summarize");
    const failed: typeof completed = {
      ...completed,
      status: "verifying",
      verification: verification("failed"),
      failure: {
        stage: "verifying",
        message: "tests failed",
        recoverable: true,
      } satisfies FailureContext,
      attempt: 0,
    };
    expect(routeAfterVerification(failed)).toBe("repair");
    expect(routeAfterVerification({ ...failed, attempt: 2 })).toBe("summarize");
    await expect(runner.getState("checkpoint-thread")).resolves.toMatchObject({
      values: { runId: "run-001", status: "completed" },
    });
    await expect(runner.resume("checkpoint-thread")).resolves.toMatchObject({
      runId: "run-001",
      status: "completed",
    });
  });
});
