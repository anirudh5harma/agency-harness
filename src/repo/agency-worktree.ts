import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { InfrastructureError, runCommand } from "../process/index.js";
import { AGENCY_LOCAL_EXCLUDE_RULE, AGENCY_WORKTREE_EXCLUDE_RULE, ensureLocalExcludeRules } from "./local-exclude.js";
import { findGitRoot } from "./repository-inspector.js";
import { withRepositoryLock } from "./repository-lock.js";

export interface AgencyWorktreeContext {
  sourceRoot: string;
  path: string;
  branch: string;
  id: string;
  createdAt: string;
  baseCommit: string;
  markerPath: string;
  ownerToken: string;
  adminDevice: number;
  adminInode: number;
}

interface WorktreeMetadata {
  version: 1;
  worktrees: AgencyWorktreeContext[];
}

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "agency";
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<string | null> {
  const result = await runCommand({ command: "git", args, cwd, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
  if (result.exitCode === 0) return result.stdout;
  if (allowFailure) return null;
  throw new InfrastructureError("GIT_COMMAND_FAILED", result.stderr.trim() || `git ${args.join(" ")} failed`);
}

function metadataPath(sourceRoot: string): string {
  return join(sourceRoot, ".devagency", "agency-worktrees.json");
}

async function ensureMetadataDirectory(sourceRoot: string): Promise<void> {
  const directory = join(sourceRoot, ".devagency");
  await mkdir(directory, { recursive: true });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", "Agency metadata directory must be a real contained directory");
}

async function load(sourceRoot: string): Promise<WorktreeMetadata> {
  await ensureMetadataDirectory(sourceRoot);
  try {
    const parsed = JSON.parse(await readFile(metadataPath(sourceRoot), "utf8")) as WorktreeMetadata;
    if (parsed.version !== 1 || !Array.isArray(parsed.worktrees)) throw new Error("invalid shape");
    return parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, worktrees: [] };
    throw new InfrastructureError("METADATA_INVALID", `Invalid Agency worktree metadata in ${sourceRoot}`, { cause });
  }
}

async function save(sourceRoot: string, metadata: WorktreeMetadata): Promise<void> {
  await ensureMetadataDirectory(sourceRoot);
  const path = metadataPath(sourceRoot);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function createAgencyWorktree(
  cwd: string,
  options: { id?: string; slug?: string } = {},
): Promise<AgencyWorktreeContext> {
  const sourceRoot = await findGitRoot(cwd);
  const head = (await git(sourceRoot, ["rev-parse", "--verify", "HEAD"], true))?.trim();
  if (!head) throw new InfrastructureError("GIT_UNBORN_HEAD", "Agency --worktree requires an existing HEAD commit");
  const sourceGitDir = resolve(sourceRoot, (await git(sourceRoot, ["rev-parse", "--git-dir"]))!.trim());
  const gitStats = await lstat(sourceGitDir);
  if (!gitStats.isDirectory() || gitStats.isSymbolicLink()) throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", "Source Git control directory must be a real directory");
  const id = safeSlug(options.id ?? randomUUID().slice(0, 8)).slice(0, 12);
  const slug = safeSlug(options.slug ?? basename(sourceRoot));
  const path = resolve(sourceRoot, ".agency-worktrees", `${slug}-${id}`);
  const branch = `agency/${slug}-${id}`;
  await ensureLocalExcludeRules(sourceRoot, [AGENCY_LOCAL_EXCLUDE_RULE, AGENCY_WORKTREE_EXCLUDE_RULE]);
  const container = dirname(path);
  await mkdir(container, { recursive: true });
  if ((await lstat(container)).isSymbolicLink()) throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", "Agency worktree container must not be a symlink");
  await git(sourceRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
  try {
    const baseCommit = (await git(path, ["rev-parse", "HEAD"]))!.trim();
    const adminDir = resolve(path, (await git(path, ["rev-parse", "--git-dir"]))!.trim());
    const adminRelative = relative(sourceGitDir, adminDir);
    if (adminRelative === ".." || adminRelative.startsWith(`..${sep}`)) throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", "Worktree admin directory escapes source Git directory");
    const adminStats = await lstat(adminDir);
    if (!adminStats.isDirectory() || adminStats.isSymbolicLink()) throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", "Worktree admin directory must be a real directory");
    const markerPath = join(adminDir, "agency-owner");
    const ownerToken = randomUUID();
    await writeFile(markerPath, `${ownerToken}\n`, { encoding: "utf8", mode: 0o600 });
    const context: AgencyWorktreeContext = { sourceRoot, path, branch, id, createdAt: new Date().toISOString(), baseCommit, markerPath, ownerToken, adminDevice: adminStats.dev, adminInode: adminStats.ino };
    await withRepositoryLock(sourceRoot, async () => {
      const metadata = await load(sourceRoot);
      metadata.worktrees = [...metadata.worktrees.filter(({ id: existing }) => existing !== id), context].slice(-100);
      await save(sourceRoot, metadata);
    });
    return context;
  } catch (cause) {
    await git(sourceRoot, ["worktree", "remove", "--force", path], true);
    await git(sourceRoot, ["update-ref", "-d", `refs/heads/${branch}`, head], true);
    throw cause;
  }
}

export async function discardAgencyWorktree(
  context: AgencyWorktreeContext,
  options: { confirmed: boolean; discardDirty?: boolean },
): Promise<void> {
  if (!options.confirmed) {
    throw new InfrastructureError("GIT_DESTRUCTIVE_CONFIRMATION_REQUIRED", "Discard requires explicit confirmation");
  }
  await withRepositoryLock(context.sourceRoot, async () => {
  const metadata = await load(context.sourceRoot);
  const owned = metadata.worktrees.find(({ id }) => id === context.id);
  if (owned === undefined || owned.path !== context.path || owned.branch !== context.branch || resolve(owned.sourceRoot) !== resolve(context.sourceRoot)) {
    throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", `Worktree ${context.path} is not an exact Agency-owned match`);
  }
  const expectedContainer = resolve(context.sourceRoot, ".agency-worktrees");
  if (dirname(resolve(context.path)) !== expectedContainer || (await lstat(expectedContainer)).isSymbolicLink()) {
    throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", "Worktree path is outside the real Agency container");
  }
  const adminDir = resolve(context.path, (await git(context.path, ["rev-parse", "--git-dir"]))!.trim());
  if (resolve(context.markerPath) !== join(adminDir, "agency-owner")) {
    throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", "Worktree marker is not in its Git admin directory");
  }
  const marker = await readFile(context.markerPath, "utf8").catch(() => "");
  if (owned.markerPath !== context.markerPath || owned.ownerToken !== context.ownerToken || marker.trim() !== context.ownerToken) {
    throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", "Worktree private ownership marker does not match source metadata");
  }
  const registrations = (await git(context.sourceRoot, ["worktree", "list", "--porcelain"])) ?? "";
  const registered = registrations.split(/\n\n/u).some((block) => block.split("\n").includes(`worktree ${context.path}`) && block.split("\n").includes(`branch refs/heads/${context.branch}`));
  if (!registered) throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", "Worktree is not registered with the exact Agency path and branch");
  const branch = (await git(context.path, ["branch", "--show-current"], true))?.trim();
  if (branch !== context.branch) {
    throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", `Worktree branch no longer matches ${context.branch}`);
  }
  const expectedCommit = (await git(context.path, ["rev-parse", "HEAD"]))!.trim();
  const branchCommit = (await git(context.sourceRoot, ["rev-parse", "--verify", `refs/heads/${context.branch}`]))!.trim();
  if (branchCommit !== expectedCommit) {
    throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", `Worktree ref no longer matches its checked-out HEAD`);
  }
  const dirty = (await git(context.path, ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).devagency", ":(exclude).devagency/**"]))?.trim() ?? "";
  const hasNewCommits = expectedCommit !== context.baseCommit;
  if ((dirty !== "" || hasNewCommits) && options.discardDirty !== true) {
    throw new InfrastructureError("GIT_WORKTREE_DIRTY", "Worktree is dirty; destructive confirmation must explicitly cover its contents");
  }
  const finalAdmin = await lstat(adminDir);
  const finalMarker = await readFile(context.markerPath, "utf8").catch(() => "");
  const finalRegistrations = (await git(context.sourceRoot, ["worktree", "list", "--porcelain"])) ?? "";
  const finalRegistered = finalRegistrations.split(/\n\n/u).some((block) => block.split("\n").includes(`worktree ${context.path}`) && block.split("\n").includes(`branch refs/heads/${context.branch}`));
  if (finalAdmin.dev !== context.adminDevice || finalAdmin.ino !== context.adminInode || finalAdmin.isSymbolicLink() || finalMarker.trim() !== context.ownerToken || !finalRegistered) {
    throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", "Worktree ownership changed immediately before removal");
  }
  // Threat model: cooperative local Git processes. Observed ownership drift
  // fails closed; a hostile process continuously racing filesystem syscalls
  // requires OS-level sandboxing outside Phase 2.
  await git(context.sourceRoot, ["worktree", "remove", ...(dirty === "" ? [] : ["--force"]), context.path]);
  const afterRegistrations = (await git(context.sourceRoot, ["worktree", "list", "--porcelain"])) ?? "";
  const stillRegistered = afterRegistrations.split(/\n\n/u).some((block) => block.split("\n").includes(`worktree ${context.path}`));
  const pathRemains = await lstat(context.path).then(() => true).catch((cause: unknown) => (cause as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(cause));
  const adminRemains = await lstat(adminDir).then(() => true).catch((cause: unknown) => (cause as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(cause));
  if (stillRegistered || pathRemains || adminRemains) throw new InfrastructureError("GIT_WORKTREE_NOT_OWNED", "Git did not fully remove the exact Agency worktree; branch was preserved");
  await git(context.sourceRoot, ["update-ref", "-d", `refs/heads/${context.branch}`, expectedCommit]);
  metadata.worktrees = metadata.worktrees.filter(({ id }) => id !== context.id);
  await save(context.sourceRoot, metadata);
  });
}

export async function agencyWorktreeDirty(context: AgencyWorktreeContext): Promise<boolean> {
  const output = await git(context.path, ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).devagency", ":(exclude).devagency/**"]);
  const head = (await git(context.path, ["rev-parse", "HEAD"]))!.trim();
  return (output ?? "").trim() !== "" || head !== context.baseCommit;
}

export async function findAgencyWorktree(cwd: string): Promise<AgencyWorktreeContext | null> {
  const root = await findGitRoot(cwd);
  const candidate = resolve(root, "..", "..");
  for (const sourceRoot of [root, candidate]) {
    const metadata = await load(sourceRoot).catch(() => null);
    const match = metadata?.worktrees.find(({ path }) => resolve(path) === resolve(root));
    if (match !== undefined) return match;
  }
  return null;
}
