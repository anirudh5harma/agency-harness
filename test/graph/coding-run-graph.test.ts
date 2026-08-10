import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  routeAfterVerification,
  type CodingRunGraphDependencies,
} from "../../src/graph/index.js";
import { IncompleteRunRegistry } from "../../src/persistence/index.js";
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
  return { status, summary: status === "passed" ? "tests passed" : "tests failed", commands: [] };
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
    const graph = createCodingRunGraph(
      dependencies(runtime, [verification("failed"), verification("passed")], root),
    );

    const state = await graph.invoke(input(root));

    expect(state.repoInstructions).toBe("[AGENTS.md]\nUse fixture conventions.");
    expect(runtime.calls.createPlan[0]?.repoInstructions).toBe(state.repoInstructions);
    expect(runtime.calls.execute[0]?.repoInstructions).toBe(state.repoInstructions);
    expect(runtime.calls.repair[0]?.repoInstructions).toBe(state.repoInstructions);
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
