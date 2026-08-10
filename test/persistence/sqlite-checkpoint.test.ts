import { mkdtemp, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  IncompleteRunRegistry,
  createSqliteCheckpointPersistence,
  inspectIncompleteRunRecovery,
} from "../../src/persistence/index.js";

const temporaryDirectories: string[] = [];
const TestStateSchema = new StateSchema({ value: z.string() });

async function temporaryProject(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agency-sqlite-checkpoint-"));
  temporaryDirectories.push(path);
  return path;
}

function compileTestGraph(
  checkpointer: Awaited<
    ReturnType<typeof createSqliteCheckpointPersistence>
  >["checkpointer"],
) {
  return new StateGraph(TestStateSchema)
    .addNode("record", (state) => ({ value: state.value }))
    .addEdge(START, "record")
    .addEdge("record", END)
    .compile({ checkpointer });
}

function config(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("SQLite checkpoint persistence", () => {
  it("survives close and reopen at .devagency/state.db", async () => {
    const projectRoot = await temporaryProject();
    const first = await createSqliteCheckpointPersistence(projectRoot);
    const firstGraph = compileTestGraph(first.checkpointer);

    await firstGraph.invoke({ value: "persisted" }, config("thread-1"));
    first.close();

    const reopened = await createSqliteCheckpointPersistence(projectRoot);
    const reopenedGraph = compileTestGraph(reopened.checkpointer);

    expect(reopened.path).toBe(join(projectRoot, ".devagency", "state.db"));
    expect((await stat(reopened.path)).isFile()).toBe(true);
    await expect(reopenedGraph.getState(config("thread-1"))).resolves.toMatchObject({
      values: { value: "persisted" },
    });
    reopened.close();
  });

  it("isolates distinct run threads", async () => {
    const projectRoot = await temporaryProject();
    const persistence = await createSqliteCheckpointPersistence(projectRoot);
    const graph = compileTestGraph(persistence.checkpointer);

    await graph.invoke({ value: "first" }, config("thread-1"));
    await graph.invoke({ value: "second" }, config("thread-2"));

    await expect(graph.getState(config("thread-1"))).resolves.toMatchObject({
      values: { value: "first" },
    });
    await expect(graph.getState(config("thread-2"))).resolves.toMatchObject({
      values: { value: "second" },
    });
    persistence.close();
  });

  it("deletes a terminal thread while retaining an incomplete thread", async () => {
    const projectRoot = await temporaryProject();
    const persistence = await createSqliteCheckpointPersistence(projectRoot);
    const graph = compileTestGraph(persistence.checkpointer);
    await graph.invoke({ value: "completed" }, config("terminal-thread"));
    await graph.invoke({ value: "executing" }, config("incomplete-thread"));

    await persistence.deleteThread("terminal-thread");

    await expect(graph.getState(config("terminal-thread"))).resolves.toMatchObject({
      values: {},
    });
    await expect(graph.getState(config("incomplete-thread"))).resolves.toMatchObject({
      values: { value: "executing" },
    });
    persistence.close();
  });

  it("closes safely more than once", async () => {
    const persistence = await createSqliteCheckpointPersistence(
      await temporaryProject(),
    );

    expect(() => persistence.close()).not.toThrow();
    expect(() => persistence.close()).not.toThrow();
  });

  it("surfaces a registry entry whose checkpoint is missing", async () => {
    const projectRoot = await temporaryProject();
    const registry = new IncompleteRunRegistry(projectRoot);
    const persistence = await createSqliteCheckpointPersistence(projectRoot);
    const graph = compileTestGraph(persistence.checkpointer);
    const entry = {
      runId: "run-missing",
      threadId: "thread-missing",
      sessionId: "session-1",
      userIntent: "Resume this work",
      status: "executing" as const,
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:01:00.000Z",
    };
    await registry.upsert(entry);

    await expect(
      inspectIncompleteRunRecovery(registry, {
        getState: (threadId) => graph.getState(config(threadId)),
      }),
    ).resolves.toEqual([{ status: "missing_checkpoint", entry, snapshot: null }]);
    await expect(registry.list()).resolves.toEqual([entry]);
    persistence.close();
  });

  it("reports matching checkpoints as resumable without duplicating graph state", async () => {
    const projectRoot = await temporaryProject();
    const registry = new IncompleteRunRegistry(projectRoot);
    const persistence = await createSqliteCheckpointPersistence(projectRoot);
    const entry = {
      runId: "run-1",
      threadId: "thread-1",
      sessionId: "session-1",
      userIntent: "Resume this work",
      status: "executing" as const,
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:01:00.000Z",
    };
    await registry.upsert(entry);
    const RunStateSchema = new StateSchema({
      runId: z.string(),
      threadId: z.string(),
    });
    const runGraph = new StateGraph(RunStateSchema)
      .addNode("record", (state) => state)
      .addEdge(START, "record")
      .addEdge("record", END)
      .compile({ checkpointer: persistence.checkpointer });
    await runGraph.invoke(
      { runId: entry.runId, threadId: entry.threadId },
      config(entry.threadId),
    );

    const inspections = await inspectIncompleteRunRecovery(registry, {
      getState: (threadId) => runGraph.getState(config(threadId)),
    });

    expect(inspections).toHaveLength(1);
    expect(inspections[0]).toMatchObject({ status: "resumable", entry });
    expect(inspections[0]?.snapshot).toMatchObject({
      values: { runId: "run-1", threadId: "thread-1" },
    });
    expect(Object.hasOwn(inspections[0] ?? {}, "state")).toBe(false);
    persistence.close();
  });

  it("classifies an END checkpoint with finalizing failure as terminal instead of resumable", async () => {
    const entry = {
      runId: "run-finalizing",
      threadId: "thread-finalizing",
      sessionId: "session-1",
      userIntent: "Resume this work",
      status: "verifying" as const,
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:01:00.000Z",
    };

    await expect(inspectIncompleteRunRecovery(
      { list: async () => [entry] },
      {
        getState: async () => ({
          values: {
            runId: entry.runId,
            threadId: entry.threadId,
            status: "failed",
            failure: { stage: "finalizing", message: "registry unavailable" },
          },
          next: [],
          tasks: [],
        }),
      },
    )).resolves.toMatchObject([{
      status: "terminal_checkpoint",
      terminalStatus: "failed",
      entry,
    }]);
  });

  it("keeps a terminal-looking checkpoint resumable while graph work remains", async () => {
    const entry = {
      runId: "run-pending",
      threadId: "thread-pending",
      sessionId: "session-1",
      userIntent: "Resume this work",
      status: "verifying" as const,
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:01:00.000Z",
    };

    await expect(inspectIncompleteRunRecovery(
      { list: async () => [entry] },
      {
        getState: async () => ({
          values: { runId: entry.runId, threadId: entry.threadId, status: "failed" },
          next: ["summarize"],
          tasks: [{ name: "summarize" }],
        }),
      },
    )).resolves.toMatchObject([{ status: "resumable", entry }]);
  });

  it("distinguishes a checkpoint owned by another run as stale", async () => {
    const projectRoot = await temporaryProject();
    const registry = new IncompleteRunRegistry(projectRoot);
    const persistence = await createSqliteCheckpointPersistence(projectRoot);
    const entry = {
      runId: "expected-run",
      threadId: "shared-thread",
      sessionId: "session-1",
      userIntent: "Resume this work",
      status: "executing" as const,
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:01:00.000Z",
    };
    await registry.upsert(entry);
    const RunStateSchema = new StateSchema({
      runId: z.string(),
      threadId: z.string(),
    });
    const graph = new StateGraph(RunStateSchema)
      .addNode("record", (state) => state)
      .addEdge(START, "record")
      .addEdge("record", END)
      .compile({ checkpointer: persistence.checkpointer });
    await graph.invoke(
      { runId: "another-run", threadId: entry.threadId },
      config(entry.threadId),
    );

    const inspections = await inspectIncompleteRunRecovery(registry, {
      getState: (threadId) => graph.getState(config(threadId)),
    });

    expect(inspections).toHaveLength(1);
    expect(inspections[0]).toMatchObject({ status: "stale_checkpoint", entry });
    await expect(registry.list()).resolves.toEqual([entry]);
    persistence.close();
  });

  it("wraps checkpoint initialization and reads in typed infrastructure errors", async () => {
    const blockedRoot = await temporaryProject();
    await writeFile(join(blockedRoot, ".devagency"), "not a directory");

    await expect(
      createSqliteCheckpointPersistence(blockedRoot),
    ).rejects.toMatchObject({ code: "CHECKPOINT_INITIALIZATION_FAILED" });

    const projectRoot = await temporaryProject();
    const registry = new IncompleteRunRegistry(projectRoot);
    await registry.upsert({
      runId: "run-1",
      threadId: "thread-1",
      sessionId: "session-1",
      userIntent: "Resume this work",
      status: "executing",
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:01:00.000Z",
    });

    await expect(
      inspectIncompleteRunRecovery(registry, {
        getState: async () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_READ_FAILED" });

    const persistence = await createSqliteCheckpointPersistence(projectRoot);
    persistence.close();
    await expect(persistence.deleteThread("thread-1")).rejects.toMatchObject({
      code: "CHECKPOINT_DELETE_FAILED",
    });
  });
});
