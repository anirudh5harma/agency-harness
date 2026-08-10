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
  /** Null means Git tracks the path, but it was absent from the worktree. */
  identity: string | null;
}

export interface GitBaseline {
  rootPath: string;
  commit: string | null;
  porcelain: string;
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

function nullSeparatedPaths(output: string | null): string[] {
  return (output ?? "").split("\0").filter(Boolean);
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

async function snapshotWorkingTree(
  rootPath: string,
): Promise<Record<string, GitPathSnapshot>> {
  const [trackedOutput, untrackedOutput] = await Promise.all([
    git(rootPath, ["ls-files", "-z"]),
    git(rootPath, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const tracked = nullSeparatedPaths(trackedOutput);
  const trackedSet = new Set(tracked);
  const paths = [...tracked, ...nullSeparatedPaths(untrackedOutput)].sort((left, right) =>
    left.localeCompare(right),
  );
  const identities = await mapWithConcurrency(paths, 16, async (path) => ({
      path,
      snapshot: {
        tracked: trackedSet.has(path),
        identity: await pathIdentity(rootPath, path),
      },
    }));
  return Object.fromEntries(
    identities.map(({ path, snapshot }) => [path, snapshot]),
  );
}

export async function captureGitBaseline(cwd: string): Promise<GitBaseline> {
  const rootPath = await findGitRoot(cwd);
  const [commit, porcelain, paths] = await Promise.all([
    git(rootPath, ["rev-parse", "--verify", "HEAD"], true),
    git(rootPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    snapshotWorkingTree(rootPath),
  ]);
  return {
    rootPath,
    commit: commit?.trim() || null,
    porcelain: porcelain?.trimEnd() ?? "",
    paths,
  };
}

export async function getChangedFiles(
  baseline: GitBaseline,
): Promise<GitFileChange[]> {
  const currentPaths = await snapshotWorkingTree(baseline.rootPath);
  const allPaths = new Set([
    ...Object.keys(baseline.paths),
    ...Object.keys(currentPaths),
  ]);
  const changes: GitFileChange[] = [];

  for (const path of allPaths) {
    const before = baseline.paths[path];
    const after = currentPaths[path];
    if (before === undefined && after !== undefined) {
      changes.push({ path, status: "added" });
    } else if (before !== undefined && after === undefined) {
      changes.push({ path, status: "deleted" });
    } else if (
      before !== undefined &&
      after !== undefined &&
      (before.identity !== after.identity || before.tracked !== after.tracked)
    ) {
      changes.push({
        path,
        status:
          before.identity !== null && after.identity === null
            ? "deleted"
            : "modified",
      });
    }
  }

  return changes.sort((left, right) => left.path.localeCompare(right.path));
}
