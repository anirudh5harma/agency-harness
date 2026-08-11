import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgencyRepl,
  gitDiff,
  PlainTerminalRenderer,
  parseCliArguments,
  runAgency,
  type ReplHandler,
  type TerminalIO,
  type TextOutput,
} from "../src/cli/index.js";
import { FakeCodingRuntime } from "../src/coding/index.js";
import type { Plan, SessionContext } from "../src/domain/index.js";
import {
  CodingRunStateSchema,
  type CodingRunGraphRunner,
} from "../src/graph/index.js";
import type { SqliteCheckpointPersistence } from "../src/persistence/index.js";
import { GitCheckpointManager, resolveGitExcludePath } from "../src/repo/index.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const builtCliPath = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const temporaryDirectories: string[] = [];

class BufferOutput implements TextOutput {
  value = "";
  write(text: string): void {
    this.value += text;
  }
}

class ScriptedIO implements TerminalIO {
  readonly prompts: string[] = [];
  closeCalls = 0;
  readonly #interruptListeners = new Set<() => void>();

  constructor(private readonly lines: Array<string | null>) {}

  async readLine(prompt: string): Promise<string | null> {
    this.prompts.push(prompt);
    return this.lines.shift() ?? null;
  }

  onInterrupt(listener: () => void): () => void {
    this.#interruptListeners.add(listener);
    return () => this.#interruptListeners.delete(listener);
  }

  close(): void {
    this.closeCalls += 1;
  }

  interrupt(): void {
    for (const listener of [...this.#interruptListeners]) listener();
  }
}

const plan: Plan = {
  objective: "Make the requested change",
  assumptions: [],
  steps: [{ id: "1", description: "Update the project" }],
  likelyFiles: [],
  verificationStrategy: ["Run tests"],
};

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function temporaryGitProject(options: { verification?: boolean } = { verification: true }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agency-cli-"));
  temporaryDirectories.push(directory);
  await git(directory, ["init", "-q"]);
  await git(directory, ["config", "user.email", "agency@example.com"]);
  await git(directory, ["config", "user.name", "Agency Test"]);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: options.verification
        ? { test: "node -e \"console.log('verified')\"" }
        : {},
    }),
  );
  await writeFile(join(directory, "tracked.txt"), "initial\n");
  await git(directory, ["add", "package.json", "tracked.txt"]);
  await git(directory, ["commit", "-qm", "initial"]);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Agency terminal application", () => {
  it("parses --worktree and --help deterministically", () => {
    expect(parseCliArguments([])).toEqual({ help: false, policy: false, worktree: false });
    expect(parseCliArguments(["--worktree", "--policy", "--help"])).toEqual({ help: true, policy: true, worktree: true });
    expect(() => parseCliArguments(["--unknown"])).toThrow("Unknown option: --unknown");
  });

  it("confirms the exact deletion plan before undo", async () => {
    const cwd = await temporaryGitProject();
    const checkpoints = new GitCheckpointManager(cwd);
    await checkpoints.create("before add");
    await checkpoints.beginRun("run-added");
    await writeFile(join(cwd, "agency-added.txt"), "added\n");
    await checkpoints.recordSuccessfulFileMutation("run-added", "agency-added.txt");
    await checkpoints.finishRun("run-added", ["agency-added.txt"]);
    const io = new ScriptedIO(["/undo", "yes", "/exit"]);
    const output = new BufferOutput();

    await runAgency({ cwd, io, output, errorOutput: new BufferOutput(), runtimeFactory: async () => new FakeCodingRuntime() });

    expect(io.prompts).toContain('Undo will delete 1 path(s): "agency-added.txt". Type yes to continue: ');
    await expect(readFile(join(cwd, "agency-added.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("compacts session context without invoking Pi or LangGraph and shows status metadata", async () => {
    const cwd = await temporaryGitProject();
    const runtime = new FakeCodingRuntime();
    const session: SessionContext = {
      sessionId: "compact-session",
      olderSummary: "",
      compactionCount: 0,
      lastCompactedAt: null,
      recentTurns: Array.from({ length: 10 }, (_, index) => ({ role: "user" as const, content: `turn ${index}` })),
      runSummaries: [],
    };
    const compacted = { ...session, olderSummary: "[turn:user] turn 0", compactionCount: 1, lastCompactedAt: "2026-01-01T00:00:00.000Z", recentTurns: session.recentTurns.slice(-6) };
    const output = new BufferOutput();
    const invoke = vi.fn();
    await runAgency({
      cwd,
      io: new ScriptedIO(["/compact", "/status", "/exit"]),
      output,
      errorOutput: new BufferOutput(),
      runtimeFactory: async () => runtime,
      sessionStoreFactory: () => ({
        loadOrCreate: async () => session,
        createNew: async () => session,
        recordUserTurn: async () => session,
        recordRunSummary: async () => session,
        compact: async () => ({ session: compacted, beforeTurns: 10, afterTurns: 6, beforeRunSummaries: 0, afterRunSummaries: 0 }),
      }),
      graphFactory: () => ({ invoke, getState: async () => ({}), resume: vi.fn() }),
      registryFactory: () => ({ list: async () => [], upsert: async () => {}, updateStatus: async () => {} }),
    });
    expect(runtime.calls).toEqual({ createPlan: [], execute: [], repair: [] });
    expect(invoke).not.toHaveBeenCalled();
    expect(output.value).toContain("Context compacted: turns 10→6, run summaries 0→0.");
    expect(output.value).toContain("yes older summary (1 compactions)");
  });
  it("cleans up initialized startup resources when a later dependency fails", async () => {
    const cwd = await temporaryGitProject();
    const io = new ScriptedIO([]);
    const closeCheckpoint = vi.fn();
    const renderer = new PlainTerminalRenderer(new BufferOutput(), new BufferOutput());
    const disposeRenderer = vi.spyOn(renderer, "dispose");

    await expect(runAgency({
      cwd,
      io,
      output: new BufferOutput(),
      errorOutput: new BufferOutput(),
      rendererFactory: () => renderer,
      checkpointFactory: async () => ({
        path: join(cwd, ".devagency", "state.db"),
        checkpointer: {} as SqliteCheckpointPersistence["checkpointer"],
        deleteThread: async () => {},
        close: closeCheckpoint,
      }),
      runtimeFactory: async () => {
        throw new Error("runtime unavailable");
      },
    })).rejects.toThrow("runtime unavailable");

    expect(io.closeCalls).toBe(1);
    expect(closeCheckpoint).toHaveBeenCalledTimes(1);
    expect(disposeRenderer).toHaveBeenCalledTimes(1);
  });

  it("uses SIGINT to close an idle REPL", async () => {
    let interrupt: (() => void) | undefined;
    let finishRead: (() => void) | undefined;
    const io: TerminalIO = {
      readLine: async () => new Promise<null>((resolve) => {
        finishRead = () => resolve(null);
      }),
      onInterrupt: (listener) => {
        interrupt = listener;
        return () => {
          interrupt = undefined;
        };
      },
      close: () => finishRead?.(),
    };
    const handler: ReplHandler = {
      handle: vi.fn(async () => "continue"),
      interruptActive: vi.fn(async () => {}),
    };

    const running = new AgencyRepl(io, handler).run();
    await vi.waitFor(() => expect(interrupt).toBeTypeOf("function"));
    interrupt?.();
    await running;

    expect(handler.handle).not.toHaveBeenCalled();
    expect(handler.interruptActive).not.toHaveBeenCalled();
  });

  it("uses SIGINT to abort an active turn without closing the REPL", async () => {
    const io = new ScriptedIO(["task", null]);
    let started: (() => void) | undefined;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const handler: ReplHandler = {
      handle: vi.fn(async (_line, signal) => {
        observedSignal = signal;
        started?.();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return "continue";
      }),
      interruptActive: vi.fn(async () => {}),
    };

    const running = new AgencyRepl(io, handler).run();
    await active;
    io.interrupt();
    await running;

    expect(observedSignal?.aborted).toBe(true);
    expect(handler.interruptActive).toHaveBeenCalledTimes(1);
    expect(io.closeCalls).toBe(0);
  });

  it("cancels a pending human decision read without resuming the graph", async () => {
    const cwd = await temporaryGitProject();
    const request = {
      id: "interrupt-choice",
      kind: "clarification" as const,
      question: "Which option?",
      options: [
        { id: "one", label: "One", description: "Choose one." },
        { id: "two", label: "Two", description: "Choose two." },
      ],
      allowCustom: true,
    };
    const session = { sessionId: "session-interrupt", recentTurns: [], runSummaries: [] };
    const interrupted = await CodingRunStateSchema.validateInput({
      runId: "run-interrupt",
      threadId: "thread-interrupt",
      sessionId: session.sessionId,
      repoPath: cwd,
      userIntent: "task",
      status: "executing",
      codingPlan: plan,
      pendingHumanDecision: request,
    });
    const listeners = new Set<() => void>();
    let reads = 0;
    let closeCalls = 0;
    const io: TerminalIO = {
      async readLine(_prompt, options) {
        reads += 1;
        if (reads === 1) return "task";
        if (reads > 2) return null;
        queueMicrotask(() => { for (const listener of listeners) listener(); });
        return new Promise<null>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(null), { once: true });
        });
      },
      onInterrupt(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() { closeCalls += 1; },
    };
    const resume = vi.fn(async () => interrupted);
    const cancelled = await CodingRunStateSchema.validateInput({
      ...interrupted,
      status: "cancelled",
      pendingHumanDecision: null,
      summary: "Run cancelled.",
    });
    const cancel = vi.fn(async () => cancelled);
    const runtime = new FakeCodingRuntime();
    const output = new BufferOutput();
    const renderer = new PlainTerminalRenderer(output, new BufferOutput());
    const setRunStatus = vi.spyOn(renderer, "setRunStatus");

    await runAgency({
      cwd,
      io,
      output,
      errorOutput: new BufferOutput(),
      rendererFactory: () => renderer,
      runtimeFactory: async () => runtime,
      createId: (() => { const ids = ["run-cli-interrupt", "thread-cli-interrupt"]; return () => ids.shift() ?? "extra"; })(),
      checkpointFactory: async () => ({
        path: join(cwd, ".devagency", "state.db"),
        checkpointer: {} as SqliteCheckpointPersistence["checkpointer"],
        deleteThread: async () => {},
        close: () => {},
      }),
      sessionStoreFactory: () => ({
        loadOrCreate: async () => session,
        createNew: async () => session,
        recordUserTurn: async () => session,
        recordRunSummary: async () => session,
      }),
      registryFactory: () => ({ list: async () => [], upsert: async () => {}, updateStatus: async () => {} }),
      graphFactory: () => ({
        invoke: async () => interrupted,
        getState: async () => ({}),
        resume,
        cancel,
      }),
    });

    expect(resume).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("thread-cli-interrupt");
    expect(runtime.abortCalls).toBe(1);
    expect(setRunStatus).toHaveBeenLastCalledWith("cancelled");
    expect(closeCalls).toBe(1);
  });

  it("keeps a clean repository clean after repeated metadata startup", async () => {
    const cwd = await temporaryGitProject();
    const beforeIgnore = await readFile(join(cwd, ".gitignore"), "utf8").catch(
      () => null,
    );

    for (let startup = 0; startup < 2; startup += 1) {
      await runAgency({
        cwd,
        io: new ScriptedIO(["/exit"]),
        output: new BufferOutput(),
        errorOutput: new BufferOutput(),
        runtimeFactory: async () => new FakeCodingRuntime(),
      });
    }

    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd },
    );
    const exclude = await readFile(await resolveGitExcludePath(cwd), "utf8");
    expect(stdout).toBe("");
    expect(exclude.split(/\r?\n/u).filter((line) => line === ".devagency/"))
      .toHaveLength(1);
    expect(await readFile(join(cwd, ".gitignore"), "utf8").catch(() => null))
      .toBe(beforeIgnore);
  });

  it("resumes an old run without attributing it to a replacement session", async () => {
    const cwd = await temporaryGitProject();
    const replacement: SessionContext = {
      sessionId: "replacement-session",
      recentTurns: [],
      runSummaries: [],
    };
    const recordRunSummary = vi.fn(async () => replacement);
    const resumed = await CodingRunStateSchema.validateInput({
      runId: "old-run",
      threadId: "old-thread",
      sessionId: "original-session",
      repoPath: cwd,
      userIntent: "old task",
      status: "completed",
      codingPlan: plan,
      verificationCommands: [
        { name: "test", command: "npm", args: ["run", "test"], required: true },
      ],
      verification: { status: "passed", summary: "tests passed", commands: [] },
      changedFiles: [],
      summary: "completed old task",
    });
    const output = new BufferOutput();
    const renderer = new PlainTerminalRenderer(output, new BufferOutput());
    const setRunStatus = vi.spyOn(renderer, "setRunStatus");
    const resume = vi.fn(async () => {
      expect(setRunStatus).toHaveBeenLastCalledWith("running");
      return resumed;
    });
    const graph: CodingRunGraphRunner = {
      invoke: vi.fn(async () => resumed),
      getState: vi.fn(async () => ({})),
      resume,
    };

    await runAgency({
      cwd,
      io: new ScriptedIO(["r", "/exit"]),
      output,
      errorOutput: new BufferOutput(),
      rendererFactory: () => renderer,
      runtimeFactory: async () => new FakeCodingRuntime(),
      checkpointFactory: async () => ({
        path: join(cwd, ".devagency", "state.db"),
        checkpointer: {} as SqliteCheckpointPersistence["checkpointer"],
        deleteThread: async () => {},
        close: () => {},
      }),
      sessionStoreFactory: () => ({
        loadOrCreate: async () => replacement,
        createNew: async () => replacement,
        recordUserTurn: async () => replacement,
        recordRunSummary,
      }),
      registryFactory: () => ({
        list: async () => [],
        upsert: async () => {},
        updateStatus: async () => {},
      }),
      graphFactory: () => graph,
      inspectRecovery: async () => [{
        status: "resumable",
        entry: {
          runId: "old-run",
          threadId: "old-thread",
          sessionId: "original-session",
          userIntent: "old task",
          status: "executing",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        snapshot: { values: resumed },
      }],
    });

    expect(graph.resume).toHaveBeenCalledWith("old-thread", undefined, expect.any(Object));
    expect(recordRunSummary).not.toHaveBeenCalled();
    expect(output.value).toContain("belongs to session original-session; the current session was left unchanged");
  });

  it("renders and resolves a pending approval during startup recovery", async () => {
    const cwd = await temporaryGitProject();
    const session: SessionContext = {
      sessionId: "session-1",
      recentTurns: [],
      runSummaries: [],
    };
    const request = {
      id: "migration-approval",
      kind: "approval" as const,
      question: "Approve the database migration?",
      risk: "It changes the schema.",
      action: "npx prisma migrate deploy",
      options: [
        { id: "approve", label: "Approve", description: "Run this exact action once." },
        { id: "reject", label: "Reject", description: "Cancel the action." },
        { id: "edit", label: "Edit", description: "Provide safer guidance." },
      ],
      allowCustom: true,
    };
    const interrupted = await CodingRunStateSchema.validateInput({
      runId: "run-approval",
      threadId: "thread-approval",
      sessionId: session.sessionId,
      repoPath: cwd,
      userIntent: "migrate database",
      status: "executing",
      codingPlan: plan,
      changedFiles: [],
      verificationCommands: [
        { name: "test", command: "npm", args: ["run", "test"], required: true },
      ],
      pendingHumanDecision: request,
    });
    const completed = {
      ...interrupted,
      status: "completed" as const,
      pendingHumanDecision: null,
      verification: { status: "passed" as const, summary: "tests passed", commands: [] },
      summary: "migration guidance applied",
    };
    const resume = vi.fn(async () => completed);
    const io = new ScriptedIO(["e", "Use a dry-run migration", "/exit"]);
    const output = new BufferOutput();

    await runAgency({
      cwd,
      io,
      output,
      errorOutput: new BufferOutput(),
      runtimeFactory: async () => new FakeCodingRuntime(),
      checkpointFactory: async () => ({
        path: join(cwd, ".devagency", "state.db"),
        checkpointer: {} as SqliteCheckpointPersistence["checkpointer"],
        deleteThread: async () => {},
        close: () => {},
      }),
      sessionStoreFactory: () => ({
        loadOrCreate: async () => session,
        createNew: async () => session,
        recordUserTurn: async () => session,
        recordRunSummary: async () => session,
      }),
      registryFactory: () => ({
        list: async () => [],
        upsert: async () => {},
        updateStatus: async () => {},
      }),
      graphFactory: () => ({
        invoke: async () => completed,
        getState: async () => ({}),
        resume,
      }),
      inspectRecovery: async () => [{
        status: "resumable",
        entry: {
          runId: interrupted.runId,
          threadId: interrupted.threadId,
          sessionId: interrupted.sessionId,
          userIntent: interrupted.userIntent,
          status: "executing",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        snapshot: { values: interrupted, next: ["human"], tasks: [] },
      }],
    });

    expect(io.prompts).toContain("Choose [a] approve, [r] reject, [e] edit: ");
    expect(io.prompts).toContain("Edited instruction: ");
    expect(resume).toHaveBeenCalledWith(
      "thread-approval",
      { requestId: request.id, customText: "Use a dry-run migration" },
      expect.any(Object),
    );
    expect(output.value).toContain("[a] Approve");
    expect(output.value).toContain("Done: migration guidance applied");
  });

  it("renders a terminal result before warning when checkpoint pruning fails", async () => {
    const cwd = await temporaryGitProject();
    const session: SessionContext = {
      sessionId: "session-1",
      recentTurns: [],
      runSummaries: [],
    };
    const completed = await CodingRunStateSchema.validateInput({
      runId: "run-1",
      threadId: "thread-1",
      sessionId: session.sessionId,
      repoPath: cwd,
      userIntent: "finish task",
      status: "completed",
      codingPlan: plan,
      verificationCommands: [
        { name: "test", command: "npm", args: ["run", "test"], required: true },
      ],
      verification: { status: "passed", summary: "tests passed", commands: [] },
      changedFiles: [],
      summary: "task complete",
    });
    const deleteThread = vi.fn(async () => {
      throw new Error("database locked");
    });
    const output = new BufferOutput();

    await expect(runAgency({
      cwd,
      io: new ScriptedIO(["finish task", "/exit"]),
      output,
      errorOutput: new BufferOutput(),
      runtimeFactory: async () => new FakeCodingRuntime(),
      checkpointFactory: async () => ({
        path: join(cwd, ".devagency", "state.db"),
        checkpointer: {} as SqliteCheckpointPersistence["checkpointer"],
        deleteThread,
        close: () => {},
      }),
      sessionStoreFactory: () => ({
        loadOrCreate: async () => session,
        createNew: async () => session,
        recordUserTurn: async () => session,
        recordRunSummary: async () => session,
      }),
      registryFactory: () => ({
        list: async () => [],
        upsert: async () => {},
        updateStatus: async () => {},
      }),
      graphFactory: () => ({
        invoke: async () => completed,
        getState: async () => ({}),
        resume: async () => completed,
      }),
    })).resolves.toBeUndefined();

    expect(deleteThread).toHaveBeenCalledWith("thread-1");
    expect(output.value.indexOf("Done: task complete"))
      .toBeLessThan(output.value.indexOf("could not prune terminal checkpoint"));
  });

  it("cleans terminal recovery records without offering them for resume", async () => {
    const cwd = await temporaryGitProject();
    const session: SessionContext = {
      sessionId: "session-1",
      recentTurns: [],
      runSummaries: [],
    };
    const updateStatus = vi.fn(async () => {});
    const deleteThread = vi.fn(async () => {
      throw new Error("database locked");
    });
    const io = new ScriptedIO(["/exit"]);
    const output = new BufferOutput();

    await expect(runAgency({
      cwd,
      io,
      output,
      errorOutput: new BufferOutput(),
      runtimeFactory: async () => new FakeCodingRuntime(),
      checkpointFactory: async () => ({
        path: join(cwd, ".devagency", "state.db"),
        checkpointer: {} as SqliteCheckpointPersistence["checkpointer"],
        deleteThread,
        close: () => {},
      }),
      sessionStoreFactory: () => ({
        loadOrCreate: async () => session,
        createNew: async () => session,
        recordUserTurn: async () => session,
        recordRunSummary: async () => session,
      }),
      registryFactory: () => ({
        list: async () => [],
        upsert: async () => {},
        updateStatus,
      }),
      graphFactory: () => ({
        invoke: async () => { throw new Error("not expected"); },
        getState: async () => ({}),
        resume: async () => { throw new Error("not expected"); },
      }),
      inspectRecovery: async () => [{
        status: "terminal_checkpoint",
        terminalStatus: "failed",
        entry: {
          runId: "run-finalizing",
          threadId: "thread-finalizing",
          sessionId: session.sessionId,
          userIntent: "old task",
          status: "verifying",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        snapshot: { values: { status: "failed" }, next: [], tasks: [] },
      }],
    })).resolves.toBeUndefined();

    expect(io.prompts).toEqual(["agency> "]);
    expect(updateStatus).toHaveBeenCalledWith(
      "run-finalizing",
      "failed",
      expect.any(String),
    );
    expect(deleteThread).toHaveBeenCalledWith("thread-finalizing");
    expect(output.value).toContain("terminal checkpoint reconciled");
    expect(output.value).toContain("could not prune terminal checkpoint");
  });

  it("declining recovery creates and retains a fresh session", async () => {
    const cwd = await temporaryGitProject();
    const original: SessionContext = {
      sessionId: "original-session",
      recentTurns: [],
      runSummaries: [],
    };
    const fresh: SessionContext = {
      sessionId: "fresh-session",
      recentTurns: [],
      runSummaries: [],
    };
    const graph: CodingRunGraphRunner = {
      invoke: vi.fn(async () => {
        throw new Error("not expected");
      }),
      getState: vi.fn(async () => ({})),
      resume: vi.fn(async () => {
        throw new Error("not expected");
      }),
    };
    const output = new BufferOutput();

    await runAgency({
      cwd,
      io: new ScriptedIO(["n", "/status", "/exit"]),
      output,
      errorOutput: new BufferOutput(),
      runtimeFactory: async () => new FakeCodingRuntime(),
      sessionStoreFactory: () => ({
        loadOrCreate: async () => original,
        createNew: vi.fn(async () => fresh),
        recordUserTurn: async () => fresh,
        recordRunSummary: async () => fresh,
      }),
      registryFactory: () => ({
        list: async () => [],
        upsert: async () => {},
        updateStatus: async () => {},
      }),
      graphFactory: () => graph,
      inspectRecovery: async () => [{
        status: "resumable",
        entry: {
          runId: "old-run",
          threadId: "old-thread",
          sessionId: "original-session",
          userIntent: "old task",
          status: "executing",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        snapshot: {},
      }],
    });

    expect(graph.resume).not.toHaveBeenCalled();
    expect(output.value).toContain("Started session fresh-session");
    expect(output.value).toContain("Session: fresh-session");
  });

  it("keeps two natural-language turns in one REPL and session", async () => {
    const cwd = await temporaryGitProject();
    const runtime = new FakeCodingRuntime();
    for (const suffix of ["one", "two"]) {
      runtime.enqueuePlanResult({ plan, message: `plan ${suffix}` });
      runtime.enqueueExecuteResult({ message: `done ${suffix}`, changedFiles: [], sessionId: "pi" });
    }
    const io = new ScriptedIO(["first task", "follow-up task", "/exit"]);
    const output = new BufferOutput();
    const errors = new BufferOutput();
    let nextId = 0;

    await runAgency({
      cwd,
      io,
      output,
      errorOutput: errors,
      runtimeFactory: async () => runtime,
      createId: () => `id-${++nextId}`,
    });

    expect(runtime.calls.createPlan).toHaveLength(2);
    expect(runtime.calls.createPlan[1]?.sessionContext?.recentTurns.map(({ content }) => content))
      .toEqual(["first task", "follow-up task"]);
    expect(runtime.calls.createPlan[0]?.sessionContext?.sessionId)
      .toBe(runtime.calls.createPlan[1]?.sessionContext?.sessionId);
    expect(io.prompts.filter((prompt) => prompt === "agency> ")).toHaveLength(3);
    expect(output.value).toContain("Done:");
    expect(runtime.isDisposed).toBe(true);
    expect(io.closeCalls).toBe(1);
    expect(await readFile(join(cwd, ".devagency", "runs", "id-1.jsonl"), "utf8"))
      .toContain('"event":"run_started"');
    expect(await readFile(join(cwd, ".devagency", "runs", "id-3.jsonl"), "utf8"))
      .toContain('"event":"run_completed"');
  }, 30_000);

  it("routes slash commands without invoking the coding runtime and starts a new session", async () => {
    const cwd = await temporaryGitProject({ verification: true });
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
    const runtime = new FakeCodingRuntime();
    const io = new ScriptedIO([
      "/help",
      "/status",
      "/diff",
      "/checkpoint before-cli-test",
      "/undo",
      "/worktree",
      "/verify",
      "/new",
      "/status",
      "/wat",
      "/exit",
    ]);
    const output = new BufferOutput();
    const errors = new BufferOutput();
    const renderer = new PlainTerminalRenderer(output, errors);
    const setRunStatus = vi.spyOn(renderer, "setRunStatus");

    await runAgency({
      cwd,
      io,
      output,
      errorOutput: errors,
      rendererFactory: () => renderer,
      runtimeFactory: async () => runtime,
    });

    expect(runtime.calls.createPlan).toHaveLength(0);
    expect(runtime.calls.execute).toHaveLength(0);
    expect(output.value).toContain("Commands:");
    expect(output.value).toContain("/mission tests|dead-code|simplify|performance");
    expect(output.value).toContain("/metrics [last]");
    expect(output.value).toContain("-initial");
    expect(output.value).toContain("+changed");
    expect(output.value).toContain("Checkpoint ");
    expect(output.value).toContain("HEAD and staging unchanged");
    expect(output.value).toContain("Undo ");
    expect(output.value).toContain("Worktree: direct checkout");
    expect(output.value).toContain("Verification: passed");
    const sessions = [...output.value.matchAll(/Session: ([^\n]+)/g)].map((match) => match[1]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).not.toBe(sessions[1]);
    expect(setRunStatus).toHaveBeenLastCalledWith("idle");
    expect(errors.value).toContain("Unknown command: /wat");
  });

  it("runs one bounded mission through the normal graph and keeps metrics read-only", async () => {
    const cwd = await temporaryGitProject();
    const runtime = new FakeCodingRuntime();
    const session: SessionContext = {
      sessionId: "mission-session",
      olderSummary: "",
      compactionCount: 0,
      lastCompactedAt: null,
      recentTurns: [],
      runSummaries: [],
    };
    const recordedTurns: string[] = [];
    const invoke = vi.fn(async (graphInput: Parameters<CodingRunGraphRunner["invoke"]>[0]) =>
      CodingRunStateSchema.validateInput({
        ...graphInput,
        status: "completed",
        summary: "mission complete",
        verification: { status: "passed", summary: "passed", commands: [] },
      }));
    const output = new BufferOutput();
    const errors = new BufferOutput();

    await runAgency({
      cwd,
      io: new ScriptedIO(["/mission tests", "/metrics", "/metrics last", "/mission unknown", "/exit"]),
      output,
      errorOutput: errors,
      runtimeFactory: async () => runtime,
      createId: (() => { let id = 0; return () => `mission-${++id}`; })(),
      sessionStoreFactory: () => ({
        loadOrCreate: async () => session,
        createNew: async () => session,
        recordUserTurn: async (content) => { recordedTurns.push(content); return session; },
        recordRunSummary: async () => session,
      }),
      graphFactory: () => ({ invoke, getState: async () => ({}), resume: vi.fn() }),
      registryFactory: () => ({ list: async () => [], upsert: async () => {}, updateStatus: async () => {} }),
      evaluationStoreFactory: () => ({
        write: async () => {},
        listRecent: async () => ({
          corruptCount: 0,
          evaluations: [{
            schemaVersion: 1,
            runId: "metric-run",
            status: "completed",
            success: true,
            durationMs: 40,
            repairAttempts: 0,
            toolCalls: 2,
            modelCalls: { planner: 1, execute: 1, repair: 0, total: 2 },
            changedFileCount: 1,
            verification: { status: "passed", commandCount: 1, durationsMs: [10] },
            humanDecisionCount: 0,
            mission: "tests",
          }],
        }),
      }),
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "mission-session",
      missionKind: "tests",
      userIntent: expect.stringContaining("choose exactly ONE"),
    }), expect.any(Object));
    expect(recordedTurns).toEqual([expect.stringContaining("Change at most 3 files")]);
    expect(runtime.calls).toEqual({ createPlan: [], execute: [], repair: [] });
    expect(output.value).toContain("Metrics: 1 recent run");
    expect(output.value).toContain("Metrics last: metric-run — completed (tests mission)");
    expect(errors.value).toContain("Unknown mission: unknown. Available: tests, dead-code, simplify, performance.");
  });

  it("shows unstaged, staged, and untracked changes without evaluating file names", async () => {
    const cwd = await temporaryGitProject();
    await writeFile(join(cwd, "tracked.txt"), "unstaged\n");
    await writeFile(join(cwd, "staged.txt"), "staged\n");
    await git(cwd, ["add", "staged.txt"]);
    const hostileName = "$(touch agency-shell-injection) untracked.txt";
    await writeFile(join(cwd, hostileName), "untracked\n");
    await mkdir(join(cwd, ".devagency"));
    await writeFile(join(cwd, ".devagency", "hidden.txt"), "internal\n");

    const diff = await gitDiff(cwd, new AbortController().signal);

    expect(diff).toContain("-initial");
    expect(diff).toContain("+unstaged");
    expect(diff).toContain("staged.txt");
    expect(diff).toContain("+staged");
    expect(diff).toContain(hostileName);
    expect(diff).toContain("+untracked");
    expect(diff).not.toContain("hidden.txt");
    await expect(readFile(join(cwd, "agency-shell-injection"), "utf8")).rejects.toThrow();
  });

  it("renders a failed graph run truthfully and returns to the prompt", async () => {
    const cwd = await temporaryGitProject();
    const runtime = new FakeCodingRuntime();
    runtime.enqueuePlanResult(new Error("planner unavailable"));
    const io = new ScriptedIO(["do something", "/exit"]);
    const output = new BufferOutput();
    const errors = new BufferOutput();

    await runAgency({ cwd, io, output, errorOutput: errors, runtimeFactory: async () => runtime });

    expect(errors.value).toContain("Failed: Run failed: planner unavailable");
    expect(output.value).not.toContain("Done:");
    expect(io.prompts.filter((prompt) => prompt === "agency> ")).toHaveLength(2);
  });

  it("fails clearly and nonzero when started outside Git", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agency-outside-git-"));
    temporaryDirectories.push(cwd);
    await execFileAsync("npm", ["run", "build"], { cwd: projectRoot });
    const error = await execFileAsync(process.execPath, [builtCliPath], { cwd, timeout: 5_000 }).catch(
      (cause: unknown) => cause as { code: number; stderr: string },
    );

    expect(error.code).not.toBe(0);
    expect(error.stderr).toContain("Agency could not start: No Git repository contains");
  });
});
