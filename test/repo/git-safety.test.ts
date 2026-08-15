import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitCheckpointManager,
  createAgencyWorktree,
  discardAgencyWorktree,
  findAgencyWorktree,
  runBoundedGitWithInput,
} from "../../src/repo/index.js";
import {
  bashApprovalAction,
  createProtectedBashTool,
  normalizePiEvent,
} from "../../src/coding/index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return (await execFileAsync("git", args, { cwd, env: { ...process.env, ...env } })).stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agency-git-safety-"));
  temporaryDirectories.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Agency Test"]);
  await git(root, ["config", "user.email", "agency@example.com"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, "delete-me.txt"), "restore me\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Git checkpoints", () => {
  it("bounds stdout from stdin-fed Git subprocesses and terminates them", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const operation = runBoundedGitWithInput(["hash-object", "--stdin"], Buffer.from("input"), {
      cwd: process.cwd(),
      maxOutputBytes: 8,
      spawnProcess: (() => child) as never,
    });
    child.stdout.write(Buffer.alloc(9));

    await expect(operation).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("times out a stalled stdin-fed Git subprocess deterministically", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => true);
      const operation = runBoundedGitWithInput(["update-index"], Buffer.from("input"), {
        cwd: process.cwd(),
        timeoutMs: 10,
        spawnProcess: (() => child) as never,
      });
      const rejection = expect(operation).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
      await vi.advanceTimersByTimeAsync(10);

      await rejection;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves HEAD, index, and status byte-identical while snapshotting dirty work", async () => {
    const root = await repository();
    await writeFile(join(root, "staged.txt"), "staged\n");
    await git(root, ["add", "staged.txt"]);
    await writeFile(join(root, "tracked.txt"), "dirty\n");
    await writeFile(join(root, "untracked.txt"), "untracked\n");
    const before = {
      head: await git(root, ["rev-parse", "HEAD"]),
      index: await readFile(join(root, ".git", "index")),
      status: await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    };

    const checkpoint = await new GitCheckpointManager(root).create("before task");

    expect(checkpoint.label).toBe("before task");
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(await readFile(join(root, ".git", "index"))).toEqual(before.index);
    expect(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toBe(before.status);
  });

  it("undoes exact Agency additions, modifications, deletions, and symlinks without touching unrelated staging", async () => {
    const root = await repository();
    await writeFile(join(root, "unrelated.txt"), "staged user work\n");
    await git(root, ["add", "unrelated.txt"]);
    const indexBefore = await readFile(join(root, ".git", "index"));
    const manager = new GitCheckpointManager(root);
    const checkpoint = await manager.create("safe point");
    await manager.beginRun("run-kinds");

    await writeFile(join(root, "tracked.txt"), "agency edit\n");
    await rm(join(root, "delete-me.txt"));
    await writeFile(join(root, "added.txt"), "agency add\n");
    await symlink("tracked.txt", join(root, "link.txt"));
    await Promise.all(["tracked.txt", "delete-me.txt", "added.txt", "link.txt"].map((path) => manager.recordSuccessfulFileMutation("run-kinds", path)));
    await manager.finishRun("run-kinds", ["tracked.txt", "delete-me.txt", "added.txt", "link.txt"]);

    const result = await manager.undo(checkpoint.id, { allowDeletes: true });

    expect(result.restored).toEqual(["added.txt", "delete-me.txt", "link.txt", "tracked.txt"]);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("base\n");
    expect(await readFile(join(root, "delete-me.txt"), "utf8")).toBe("restore me\n");
    await expect(readFile(join(root, "added.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "link.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".git", "index"))).toEqual(indexBefore);
  }, 30_000);

  it("refuses a path edited by the user after Agency", async () => {
    const root = await repository();
    const manager = new GitCheckpointManager(root);
    const checkpoint = await manager.create();
    await manager.beginRun("run-diverged");
    await writeFile(join(root, "tracked.txt"), "agency edit\n");
    await manager.recordSuccessfulFileMutation("run-diverged", "tracked.txt");
    await manager.finishRun("run-diverged", ["tracked.txt"]);
    await writeFile(join(root, "tracked.txt"), "later user edit\n");

    const result = await manager.undo(checkpoint.id, { allowDeletes: true });

    expect(result).toMatchObject({ restored: [], diverged: ["tracked.txt"] });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("later user edit\n");
  });

  it("revalidates identities after preparing an undo plan", async () => {
    const root = await repository();
    const manager = new GitCheckpointManager(root);
    const checkpoint = await manager.create();
    await manager.beginRun("run-race");
    await writeFile(join(root, "tracked.txt"), "agency edit\n");
    await manager.recordSuccessfulFileMutation("run-race", "tracked.txt");
    await manager.finishRun("run-race", ["tracked.txt"]);
    const plan = await manager.prepareUndo(checkpoint.id);
    await writeFile(join(root, "tracked.txt"), "concurrent user edit\n");

    const result = await manager.applyUndo(plan, { allowDeletes: true });
    expect(result).toMatchObject({ restored: [], diverged: ["tracked.txt"] });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("concurrent user edit\n");
  });

  it("rolls back earlier replacements when a later materialization fails", async () => {
    const root = await repository();
    const manager = new GitCheckpointManager(root);
    const checkpoint = await manager.create();
    await manager.beginRun("run-rollback");
    await writeFile(join(root, "tracked.txt"), "agency tracked\n");
    await writeFile(join(root, "delete-me.txt"), "agency second\n");
    await Promise.all(["tracked.txt", "delete-me.txt"].map((path) => manager.recordSuccessfulFileMutation("run-rollback", path)));
    await manager.finishRun("run-rollback", ["tracked.txt", "delete-me.txt"]);
    const plan = await manager.prepareUndo(checkpoint.id);
    const lastMaterialized = plan.entries.at(-1)?.materializedPath;
    expect(lastMaterialized).toBeTypeOf("string");
    await rm(lastMaterialized!);

    await expect(manager.applyUndo(plan, { allowDeletes: true })).rejects.toMatchObject({ code: "GIT_CHECKPOINT_INVALID" });
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("agency tracked\n");
    expect(await readFile(join(root, "delete-me.txt"), "utf8")).toBe("agency second\n");
  });

  it("reports late installed-target tampering and preserves the original backup", async () => {
    const root = await repository();
    const manager = new GitCheckpointManager(root, {
      afterInstall: async (path) => { await writeFile(join(root, path), "late concurrent edit\n"); },
    });
    const checkpoint = await manager.create();
    await manager.beginRun("run-late-tamper");
    await writeFile(join(root, "tracked.txt"), "agency edit\n");
    await manager.recordSuccessfulFileMutation("run-late-tamper", "tracked.txt");
    await manager.finishRun("run-late-tamper", ["tracked.txt"]);
    const plan = await manager.prepareUndo(checkpoint.id);

    await expect(manager.applyUndo(plan, { allowDeletes: true })).rejects.toThrow("partial rollback failures preserved backups");
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("late concurrent edit\n");
    expect(await readFile(`${join(root, "tracked.txt")}.agency-undo-${plan.token}.bak`, "utf8")).toBe("agency edit\n");
  });

  it("binds ownership to checkpoint and pre-run identity", async () => {
    const root = await repository();
    const manager = new GitCheckpointManager(root);
    const checkpoint = await manager.create();
    await writeFile(join(root, "tracked.txt"), "user before run\n");
    await manager.beginRun("run-user-dirty");
    await writeFile(join(root, "tracked.txt"), "agency overwrote user\n");
    await manager.recordSuccessfulFileMutation("run-user-dirty", "tracked.txt");
    await manager.finishRun("run-user-dirty", ["tracked.txt"]);

    const result = await manager.undo(checkpoint.id, { allowDeletes: true });
    expect(result.restored).toEqual([]);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("agency overwrote user\n");
  });

  it("does not claim a user edit made after an Agency mutation boundary", async () => {
    const root = await repository();
    const manager = new GitCheckpointManager(root);
    const checkpoint = await manager.create();
    await manager.beginRun("run-post-event-user");
    await writeFile(join(root, "tracked.txt"), "agency edit\n");
    await manager.recordSuccessfulFileMutation("run-post-event-user", "tracked.txt");
    await writeFile(join(root, "tracked.txt"), "user after event\n");
    await manager.finishRun("run-post-event-user", ["tracked.txt"]);

    expect((await manager.undo(checkpoint.id, { allowDeletes: true })).restored).toEqual([]);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("user after event\n");
  });

  it("leaves bash and interrupted edits unclaimed without a successful file event", async () => {
    const root = await repository();
    const manager = new GitCheckpointManager(root);
    const checkpoint = await manager.create();
    await manager.beginRun("run-bash");
    await writeFile(join(root, "tracked.txt"), "opaque bash edit\n");
    await manager.finishRun("run-bash");
    expect((await manager.undo(checkpoint.id, { allowDeletes: true })).restored).toEqual([]);
  });

  it("records failed-run deltas through the same run binding", async () => {
    const root = await repository();
    const manager = new GitCheckpointManager(root);
    const checkpoint = await manager.create();
    await manager.beginRun("run-failed");
    await writeFile(join(root, "tracked.txt"), "failed run edit\n");
    await manager.recordSuccessfulFileMutation("run-failed", "tracked.txt");
    const recovered = new GitCheckpointManager(root);
    await recovered.beginRun("run-failed");
    await recovered.finishRun("run-failed", ["tracked.txt"]);
    expect((await recovered.undo(checkpoint.id, { allowDeletes: true })).restored).toEqual(["tracked.txt"]);
  });

  it("segments recovery so resumed writes undo to the resume-time tree", async () => {
    const root = await repository();
    const manager = new GitCheckpointManager(root);
    await manager.create("A");
    await manager.beginRun("registry-run");
    await writeFile(join(root, "tracked.txt"), "B user after crash\n");

    const segmentId = await manager.segmentRecoveryRun("registry-run");
    expect(segmentId).toMatch(/^registry-run\.resume-/u);
    await writeFile(join(root, "tracked.txt"), "C resumed Agency\n");
    await manager.recordSuccessfulFileMutation(segmentId, "tracked.txt");
    await manager.finishRun(segmentId, ["tracked.txt"]);

    const result = await manager.undo(undefined, { allowDeletes: true });
    expect(result.restored).toEqual(["tracked.txt"]);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("B user after crash\n");
  });

  it("restores arbitrary file bytes exactly", async () => {
    const root = await repository();
    const original = Buffer.from([0, 255, 1, 128, 10]);
    await writeFile(join(root, "binary.dat"), original);
    const manager = new GitCheckpointManager(root);
    const checkpoint = await manager.create();
    await manager.beginRun("run-binary");
    await writeFile(join(root, "binary.dat"), Buffer.from([9, 8, 7]));
    await manager.recordSuccessfulFileMutation("run-binary", "binary.dat");
    await manager.finishRun("run-binary", ["binary.dat"]);

    await manager.undo(checkpoint.id, { allowDeletes: true });

    expect(await readFile(join(root, "binary.dat"))).toEqual(original);
  });

  it("stores raw working-tree bytes without clean filters and ignores a swapped ref", async () => {
    const root = await repository();
    await writeFile(join(root, ".gitattributes"), "filtered.txt text eol=lf\n");
    const original = Buffer.from("one\r\ntwo\r\n");
    await writeFile(join(root, "filtered.txt"), original);
    const manager = new GitCheckpointManager(root);
    const checkpoint = await manager.create();
    await manager.beginRun("run-filtered");
    await git(root, ["update-ref", checkpoint.ref, "HEAD"]);
    await writeFile(join(root, "filtered.txt"), "changed\n");
    await manager.recordSuccessfulFileMutation("run-filtered", "filtered.txt");
    await manager.finishRun("run-filtered", ["filtered.txt"]);

    await manager.undo(checkpoint.id, { allowDeletes: true });
    expect(await readFile(join(root, "filtered.txt"))).toEqual(original);
  });

  it("serializes concurrent checkpoint metadata transactions", async () => {
    const root = await repository();
    const manager = new GitCheckpointManager(root);
    const created = await Promise.all([manager.create("one"), manager.create("two")]);
    expect(new Set(created.map(({ id }) => id)).size).toBe(2);
    expect((await manager.list()).map(({ id }) => id)).toEqual(expect.arrayContaining(created.map(({ id }) => id)));
  });

  it("atomically quarantines and replaces a dead repository lease", async () => {
    const root = await repository();
    await mkdir(join(root, ".devagency"));
    await writeFile(join(root, ".devagency", "repository.lock"), JSON.stringify({ pid: 999_999_999, token: "dead" }));
    const checkpoint = await new GitCheckpointManager(root).create("after crash");
    expect(checkpoint.id).toBeTruthy();
    await expect(readFile(join(root, ".devagency", "repository.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims malformed leases only after their grace period", async () => {
    const root = await repository();
    await mkdir(join(root, ".devagency"));
    const lock = join(root, ".devagency", "repository.lock");
    await writeFile(lock, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect((await new GitCheckpointManager(root).create("after malformed lease")).id).toBeTruthy();
  });

  it("quarantines an unchanged stale lease after PID reuse", async () => {
    const root = await repository();
    await mkdir(join(root, ".devagency"));
    await writeFile(join(root, ".devagency", "repository.lock"), JSON.stringify({
      pid: process.pid,
      token: "prior-process",
      createdAt: 0,
      processStartId: "prior-process-start",
    }));
    expect((await new GitCheckpointManager(root).create("pid reuse")).id).toBeTruthy();
  });

  it("rejects an oversized path before publishing checkpoint metadata or refs", async () => {
    const root = await repository();
    await writeFile(join(root, "large.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
    const manager = new GitCheckpointManager(root);
    await expect(manager.create("too large")).rejects.toMatchObject({ code: "GIT_CHECKPOINT_PATH_TOO_LARGE" });
    expect(await manager.list()).toEqual([]);
    expect((await git(root, ["for-each-ref", "--format=%(refname)", "refs/agency/checkpoints"])).trim()).toBe("");
  });

  it("rejects traversal and symlink-parent escapes", async () => {
    const root = await repository();
    const manager = new GitCheckpointManager(root);
    await manager.create();
    await manager.beginRun("run-unsafe");
    await expect(manager.finishRun("run-unsafe", ["../escape"])).rejects.toMatchObject({ code: "GIT_UNSAFE_PATH" });
    await manager.beginRun("run-unsafe-two");
    await symlink(tmpdir(), join(root, "escaped"));
    await expect(manager.finishRun("run-unsafe-two", ["escaped/file"])).rejects.toMatchObject({ code: "GIT_UNSAFE_PATH" });
  });
});

describe("Agency worktrees", () => {
  it("discovers read-only when neither repository nor ancestor has a registry", async () => {
    const outer = await mkdtemp(join(tmpdir(), "agency-worktree-discovery-"));
    temporaryDirectories.push(outer);
    const root = join(outer, "projects", "target");
    await mkdir(root, { recursive: true });
    await git(root, ["init", "-q"]);

    await expect(findAgencyWorktree(root)).resolves.toBeNull();
    await expect(lstat(join(root, ".devagency"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(outer, ".devagency"))).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(join(root, ".devagency"), { mode: 0o755 });
    const modeBefore = (await lstat(join(root, ".devagency"))).mode & 0o777;
    await expect(findAgencyWorktree(root)).resolves.toBeNull();
    expect((await lstat(join(root, ".devagency"))).mode & 0o777).toBe(modeBefore);
  });

  it("creates isolated owned worktree and only discards exact clean ownership", async () => {
    const root = await repository();
    const context = await createAgencyWorktree(root, { id: "12345678", slug: "test project" });
    temporaryDirectories.push(context.path);
    expect(context.path).toBe(join(context.sourceRoot, ".agency-worktrees", "test-project-12345678"));
    expect((await git(context.path, ["branch", "--show-current"])).trim()).toBe(context.branch);
    expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).toContain(".agency-worktrees/");

    await expect(discardAgencyWorktree(context, { confirmed: false })).rejects.toMatchObject({ code: "GIT_DESTRUCTIVE_CONFIRMATION_REQUIRED" });
    await discardAgencyWorktree(context, { confirmed: true });
    expect((await git(root, ["branch", "--list", context.branch])).trim()).toBe("");
  });

  it("rejects unborn worktree creation truthfully", async () => {
    const root = await mkdtemp(join(tmpdir(), "agency-unborn-"));
    temporaryDirectories.push(root);
    await git(root, ["init", "-q"]);
    await expect(createAgencyWorktree(root)).rejects.toMatchObject({ code: "GIT_UNBORN_HEAD" });
  });

  it("refuses discard after its private ownership marker is changed", async () => {
    const root = await repository();
    const context = await createAgencyWorktree(root, { id: "marker123", slug: "marker" });
    temporaryDirectories.push(context.path);
    await writeFile(context.markerPath, "tampered\n");
    await expect(discardAgencyWorktree(context, { confirmed: true })).rejects.toMatchObject({ code: "GIT_WORKTREE_NOT_OWNED" });
  });

  it("refuses dirty discard unless confirmation explicitly includes dirty contents", async () => {
    const root = await repository();
    const context = await createAgencyWorktree(root, { id: "abcdef12", slug: "dirty" });
    temporaryDirectories.push(context.path);
    await writeFile(join(context.path, "tracked.txt"), "dirty\n");

    await expect(discardAgencyWorktree(context, { confirmed: true })).rejects.toMatchObject({ code: "GIT_WORKTREE_DIRTY" });
    await discardAgencyWorktree(context, { confirmed: true, discardDirty: true });
  });
});

describe("protected shell deletion ownership", () => {
  it("restores an unchanged exact-approved deletion and refuses a user-diverged path", async () => {
    const exercise = async (diverge: boolean) => {
      const root = await repository();
      const manager = new GitCheckpointManager(root);
      const checkpoint = await manager.create("before protected rm");
      const runId = diverge ? "rm-diverged" : "rm-unchanged";
      await manager.beginRun(runId);
      const command = "rm delete-me.txt";
      const approval = bashApprovalAction(["rm", "delete-me.txt"]);
      const bash = createProtectedBashTool({
        root,
        consumeApproval: (action) => action === approval,
      });
      const state = {
        calls: new Map(),
        changedFiles: new Set<string>(),
        finalMessage: "",
        providerError: undefined,
      };
      normalizePiEvent({
        type: "tool_execution_start",
        toolCallId: runId,
        toolName: "bash",
        args: { command },
      }, state);
      const result = await bash.execute(runId, { command }, undefined, undefined, {} as never);
      const events = normalizePiEvent({
        type: "tool_execution_end",
        toolCallId: runId,
        toolName: "bash",
        result,
        isError: false,
      }, state);
      for (const event of events) {
        if (event.type === "file_changed") await manager.recordSuccessfulFileMutation(runId, event.path);
      }
      if (diverge) await writeFile(join(root, "delete-me.txt"), "user replacement\n");
      await manager.finishRun(runId, [...state.changedFiles]);
      return { root, checkpoint, undo: await manager.undo(checkpoint.id, { allowDeletes: true }) };
    };

    const unchanged = await exercise(false);
    expect(unchanged.undo.restored).toEqual(["delete-me.txt"]);
    expect(await readFile(join(unchanged.root, "delete-me.txt"), "utf8")).toBe("restore me\n");

    const diverged = await exercise(true);
    expect(diverged.undo.restored).toEqual([]);
    expect(await readFile(join(diverged.root, "delete-me.txt"), "utf8")).toBe("user replacement\n");
  });
});
