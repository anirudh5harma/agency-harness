import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { InfrastructureError, runCommand } from "../process/index.js";
import { findGitRoot } from "./repository-inspector.js";

export type GitFileStatus = "added" | "modified" | "deleted";

export interface GitFileChange {
  path: string;
  status: GitFileStatus;
}

export interface GitPathSnapshot {
  tracked: boolean;
  /** The two-character porcelain v1 index/worktree state. */
  statusCode: string;
  /** Null means Git tracks the path, but it was absent from the worktree. */
  identity: string | null;
}

export interface GitBaseline {
  rootPath: string;
  commit: string | null;
  /** Stable SHA-256 identity of the staged index entries. */
  indexTree: string;
  paths: Record<string, GitPathSnapshot>;
}

const GIT_LIST_OUTPUT_LIMIT = 16 * 1024 * 1024;

async function git(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<string | null> {
  const result = await runCommand({
    command: "git",
    args,
    cwd,
    timeoutMs: 15_000,
    maxOutputBytes: GIT_LIST_OUTPUT_LIMIT,
  });
  if (result.exitCode === 0) return result.stdout;
  if (allowFailure) return null;
  throw new InfrastructureError(
    "GIT_COMMAND_FAILED",
    `Git command failed in ${cwd}: git ${args.join(" ")}`,
  );
}

async function pathIdentity(rootPath: string, path: string): Promise<string | null> {
  const absolutePath = join(rootPath, path);
  let stats: Stats;
  try {
    stats = await lstat(absolutePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }

  const executableMode = stats.mode & 0o111;
  if (stats.isSymbolicLink()) {
    const target = await readlink(absolutePath);
    return `symlink:${executableMode}:${Buffer.byteLength(target)}:${createHash("sha256").update(target).digest("hex")}`;
  }
  if (!stats.isFile()) {
    return `other:${stats.mode}:${stats.size}:${stats.mtimeMs}`;
  }

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return `file:${executableMode}:${stats.size}:${hash.digest("hex")}`;
}

interface StatusEntry {
  path: string;
  statusCode: string;
  status: GitFileStatus;
  tracked: boolean;
}

function parseStatus(output: string | null): StatusEntry[] {
  return (output ?? "")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const code = entry.slice(0, 2);
      return {
        path: entry.slice(3),
        statusCode: code,
        status:
          code === "??"
            ? "added"
            : code.includes("D")
              ? "deleted"
              : code.includes("A")
                ? "added"
                : "modified",
        tracked: code !== "??",
      };
    });
}

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const outputs = new Array<Output>(inputs.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex++;
        const input = inputs[index];
        if (input !== undefined) outputs[index] = await mapper(input);
      }
    }),
  );
  return outputs;
}

async function statusEntries(rootPath: string): Promise<StatusEntry[]> {
  return parseStatus(
    await git(rootPath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ]),
  );
}

async function indexIdentity(rootPath: string): Promise<string> {
  const stagedEntries = await git(rootPath, ["ls-files", "--stage", "-z"]);
  return createHash("sha256").update(stagedEntries ?? "").digest("hex");
}

async function snapshotDirtyPaths(
  rootPath: string,
): Promise<Record<string, GitPathSnapshot>> {
  const entries = await statusEntries(rootPath);
  const identities = await mapWithConcurrency(
    entries,
    16,
    async ({ path, tracked, statusCode }) => ({
      path,
      snapshot: {
        tracked,
        statusCode,
        identity: await pathIdentity(rootPath, path),
      },
    }),
  );
  return Object.fromEntries(
    identities.map(({ path, snapshot }) => [path, snapshot]),
  );
}

export async function captureGitBaseline(cwd: string): Promise<GitBaseline> {
  const rootPath = await findGitRoot(cwd);
  const [commit, indexTree, paths] = await Promise.all([
    git(rootPath, ["rev-parse", "--verify", "HEAD"], true),
    indexIdentity(rootPath),
    snapshotDirtyPaths(rootPath),
  ]);
  return {
    rootPath,
    commit: commit?.trim() || null,
    indexTree: indexTree?.trim() ?? "",
    paths,
  };
}

export async function getChangedFiles(
  baseline: GitBaseline,
): Promise<GitFileChange[]> {
  const [currentCommit, currentIndexTree, currentEntries] = await Promise.all([
    git(baseline.rootPath, ["rev-parse", "--verify", "HEAD"], true),
    indexIdentity(baseline.rootPath),
    statusEntries(baseline.rootPath),
  ]);
  const normalizedCommit = currentCommit?.trim() || null;
  const normalizedIndexTree = currentIndexTree?.trim() ?? "";
  if (
    normalizedCommit !== baseline.commit ||
    normalizedIndexTree !== baseline.indexTree
  ) {
    const mutation =
      normalizedCommit !== baseline.commit ? "HEAD commit" : "Git index";
    throw new InfrastructureError(
      "GIT_BASELINE_VIOLATED",
      `${mutation} changed after Agency captured its baseline in ${baseline.rootPath}`,
    );
  }
  const currentByPath = new Map(currentEntries.map((entry) => [entry.path, entry]));
  const changes: GitFileChange[] = [];

  for (const { path, status } of currentEntries) {
    const before = baseline.paths[path];
    if (before === undefined) changes.push({ path, status });
  }

  const currentSnapshots = await mapWithConcurrency(
    Object.entries(baseline.paths),
    16,
    async ([path, before]) => ({
      path,
      before,
      identity: await pathIdentity(baseline.rootPath, path),
    }),
  );
  for (const { path, before, identity } of currentSnapshots) {
    const current = currentByPath.get(path);
    if (
      identity !== before.identity ||
      current?.tracked !== before.tracked ||
      current?.statusCode !== before.statusCode
    ) {
      changes.push({
        path,
        status:
          before.identity !== null && identity === null
            ? "deleted"
            : "modified",
      });
    }
  }

  return changes
    .filter(
      (change, index, all) =>
        all.findIndex((candidate) => candidate.path === change.path) === index,
    )
    .sort((left, right) => left.path.localeCompare(right.path));
}
