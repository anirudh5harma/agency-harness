import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { InfrastructureError, runCommand } from "../process/index.js";
import {
  AGENCY_LOCAL_EXCLUDE_RULE,
  AGENCY_WORKTREE_EXCLUDE_RULE,
  ensureLocalExcludeRules,
} from "./local-exclude.js";
import { withRepositoryLock } from "./repository-lock.js";

const MAX_CHECKPOINTS = 100;
const MAX_PATHS = 2_000;
const METADATA_VERSION = 1;
const MAX_CHECKPOINT_PATH_BYTES = 16 * 1024 * 1024;

export interface CheckpointPathMetadata {
  checkpointIdentity: string | null;
  postAgencyIdentity?: string | null;
}

export interface GitCheckpoint {
  id: string;
  ref: string;
  tree: string;
  commit: string;
  baseHead: string | null;
  createdAt: string;
  label?: string;
  paths: Record<string, CheckpointPathMetadata>;
}

interface CheckpointFile {
  version: typeof METADATA_VERSION;
  checkpoints: GitCheckpoint[];
  runBindings: Record<string, {
    checkpointId: string;
    preRunIdentities: Record<string, string | null>;
    agencyPostIdentities: Record<string, string | null>;
  }>;
}

export interface UndoResult {
  checkpointId: string;
  restored: string[];
  diverged: string[];
  unchanged: string[];
  deletionsRequired: string[];
}

export interface UndoPlanEntry {
  path: string;
  expectedIdentity: string | null;
  checkpointIdentity: string | null;
  materializedPath?: string;
  mode?: "100644" | "100755" | "120000";
}

export interface UndoPlan extends UndoResult {
  token: string;
  entries: UndoPlanEntry[];
  materializationRoot: string;
}

function unsafePath(message: string): InfrastructureError {
  return new InfrastructureError("GIT_UNSAFE_PATH", message);
}

async function validatePath(root: string, path: string): Promise<string> {
  if (
    path === "" || path.includes("\0") || isAbsolute(path) ||
    path.split(/[\\/]/u).some((part) => part === "" || part === "." || part === "..") ||
    path === ".devagency" || path.startsWith(".devagency/") ||
    path === ".agency-worktrees" || path.startsWith(".agency-worktrees/")
  ) {
    throw unsafePath(`Unsafe checkpoint path: ${JSON.stringify(path)}`);
  }
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw unsafePath(`Checkpoint path escapes repository: ${JSON.stringify(path)}`);
  }
  let parent = dirname(absolute);
  const parents: string[] = [];
  while (parent !== root) {
    parents.push(parent);
    parent = dirname(parent);
  }
  for (const candidate of parents.reverse()) {
    try {
      if ((await lstat(candidate)).isSymbolicLink()) {
        throw unsafePath(`Checkpoint path crosses symlink: ${JSON.stringify(path)}`);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  return absolute;
}

interface ExactPathCapture { content: Buffer; identity: string; mode: "100644" | "100755" | "120000" }

function capturePathExact(root: string, path: string): ExactPathCapture | null {
  if (path === "" || path.includes("\0") || isAbsolute(path) || path.split(/[\\/]/u).some((part) => part === "" || part === "." || part === "..")) throw unsafePath(`Unsafe mutation path: ${JSON.stringify(path)}`);
  const absolute = resolve(root, path);
  if (relative(root, absolute) === ".." || relative(root, absolute).startsWith(`..${sep}`)) throw unsafePath(`Mutation path escapes repository: ${JSON.stringify(path)}`);
  let parent = dirname(absolute);
  while (parent !== root) {
    try { if (lstatSync(parent).isSymbolicLink()) throw unsafePath(`Mutation path crosses symlink: ${JSON.stringify(path)}`); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    parent = dirname(parent);
  }
  try {
    const stats = lstatSync(absolute);
    const executable = stats.mode & 0o111;
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      const after = lstatSync(absolute);
      if (!after.isSymbolicLink() || stats.dev !== after.dev || stats.ino !== after.ino || stats.mtimeMs !== after.mtimeMs || stats.size !== after.size) throw new InfrastructureError("GIT_CHECKPOINT_INVALID", `Symlink changed during capture: ${path}`);
      const content = Buffer.from(target);
      return { content, mode: "120000", identity: `symlink:${executable}:${content.byteLength}:${createHash("sha256").update(content).digest("hex")}` };
    }
    if (!stats.isFile()) return null;
    const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(descriptor);
      if (before.size > MAX_CHECKPOINT_PATH_BYTES) throw new InfrastructureError("GIT_CHECKPOINT_PATH_TOO_LARGE", `Path exceeds 16 MiB: ${path}`);
      const content = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      const finalPath = lstatSync(absolute);
      if (!before.isFile() || !after.isFile() || !finalPath.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || finalPath.dev !== before.dev || finalPath.ino !== before.ino || finalPath.size !== before.size || content.byteLength !== before.size) throw new InfrastructureError("GIT_CHECKPOINT_INVALID", `Path changed during capture: ${path}`);
      const mode = (after.mode & 0o111) === 0 ? "100644" : "100755";
      return { content, mode, identity: `file:${after.mode & 0o111}:${content.byteLength}:${createHash("sha256").update(content).digest("hex")}` };
    } finally { closeSync(descriptor); }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

async function identity(root: string, path: string): Promise<string | null> { return capturePathExact(root, path)?.identity ?? null; }

export class GitCheckpointManager {
  readonly #metadataPath: string;
  readonly #afterInstall: ((path: string) => Promise<void>) | undefined;

  constructor(readonly root: string, options: { afterInstall?: (path: string) => Promise<void> } = {}) {
    this.#metadataPath = join(root, ".devagency", "git-checkpoints.json");
    this.#afterInstall = options.afterInstall;
  }

  async create(label?: string): Promise<GitCheckpoint> {
    await ensureLocalExcludeRules(this.root, [
      AGENCY_LOCAL_EXCLUDE_RULE,
      AGENCY_WORKTREE_EXCLUDE_RULE,
    ]);
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const ref = `refs/agency/checkpoints/${id}`;
    const safeLabel = label?.trim().slice(0, 200);
    return this.#withLock(async () => {
      let refCreated = false;
      let createdCommit: string | undefined;
      try {
      const baseHead = (await this.#git(["rev-parse", "--verify", "HEAD"], true))?.trim() || null;
      const snapshot = await this.#snapshotWorkingTree();
      const tree = snapshot.tree;
      const commitArgs = ["commit-tree", tree, "-m", safeLabel || `Agency checkpoint ${id}`];
      if (baseHead !== null) commitArgs.push("-p", baseHead);
      const commit = (await this.#git(commitArgs, false, {
        GIT_AUTHOR_NAME: "Agency Checkpoint",
        GIT_AUTHOR_EMAIL: "checkpoint@agency.local",
        GIT_COMMITTER_NAME: "Agency Checkpoint",
        GIT_COMMITTER_EMAIL: "checkpoint@agency.local",
      }))!.trim();
      createdCommit = commit;
      await this.#git(["update-ref", ref, commit, "0".repeat(commit.length)]);
      refCreated = true;
      const checkpoint: GitCheckpoint = {
        id,
        ref,
        tree,
        commit,
        baseHead,
        createdAt: new Date().toISOString(),
        ...(safeLabel ? { label: safeLabel } : {}),
        paths: Object.fromEntries(Object.entries(snapshot.identities).map(([path, checkpointIdentity]) => [path, { checkpointIdentity }])),
      };
      const file = await this.#load();
      file.checkpoints.push(checkpoint);
      const dropped = file.checkpoints.slice(0, -MAX_CHECKPOINTS);
      file.checkpoints = file.checkpoints.slice(-MAX_CHECKPOINTS);
      await this.#save(file);
      for (const old of dropped) await this.#git(["update-ref", "-d", old.ref, old.commit], true);
      return checkpoint;
      } catch (cause) {
        if (refCreated && createdCommit !== undefined) await this.#git(["update-ref", "-d", ref, createdCommit], true);
        throw cause;
      }
    });
  }

  async list(): Promise<GitCheckpoint[]> {
    return (await this.#load()).checkpoints;
  }

  async beginRun(runId: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(runId)) throw new InfrastructureError("GIT_CHECKPOINT_INVALID", `Invalid run id ${runId}`);
    await this.#withLock(async () => {
      const file = await this.#load();
      if (file.runBindings[runId] !== undefined) return;
      const checkpoint = file.checkpoints.at(-1);
      if (checkpoint === undefined) return;
      const snapshot = await this.#snapshotWorkingTree();
      file.runBindings[runId] = { checkpointId: checkpoint.id, preRunIdentities: snapshot.identities, agencyPostIdentities: {} };
      await this.#save(file);
    });
  }

  async segmentRecoveryRun(registryRunId: string): Promise<string> {
    // Close the crash-era binding first. Final equality prevents post-crash
    // user state from being attributed to Agency.
    await this.finishRun(registryRunId);
    await this.create(`[internal recovery baseline] ${registryRunId}`);
    const segmentId = `${registryRunId.slice(0, 96)}.resume-${randomUUID().slice(0, 8)}`;
    await this.beginRun(segmentId);
    return segmentId;
  }

  recordSuccessfulFileMutation(runId: string, path: string): Promise<void> {
    // Capture synchronously in the event callback. Persistence may queue, but
    // identity can no longer drift before capture.
    const captured = capturePathExact(this.root, path)?.identity ?? null;
    return this.#withLock(async () => {
      const file = await this.#load();
      const binding = file.runBindings[runId];
      if (binding === undefined) return;
      binding.agencyPostIdentities[path] = captured;
      await this.#save(file);
    });
  }

  async finishRun(runId: string, changedPaths?: readonly string[]): Promise<void> {
    if (changedPaths !== undefined) for (const path of changedPaths) await validatePath(this.root, path);
    await this.#withLock(async () => {
      const file = await this.#load();
      const binding = file.runBindings[runId];
      if (binding === undefined) return;
      const checkpoint = file.checkpoints.find(({ id }) => id === binding.checkpointId);
      if (checkpoint === undefined) {
        delete file.runBindings[runId];
        await this.#save(file);
        return;
      }
      const current = await this.#snapshotWorkingTree();
      const candidates = changedPaths === undefined ? Object.keys(binding.agencyPostIdentities) : [...new Set(changedPaths)].filter((path) => path in binding.agencyPostIdentities);
      for (const path of candidates) {
        await validatePath(this.root, path);
        const preRun = binding.preRunIdentities[path] ?? null;
        const atCheckpoint = checkpoint.paths[path]?.checkpointIdentity ?? null;
        if (preRun !== atCheckpoint) continue;
        const agencyPost = binding.agencyPostIdentities[path] ?? null;
        if ((current.identities[path] ?? null) !== agencyPost) continue;
        checkpoint.paths[path] = { checkpointIdentity: atCheckpoint, postAgencyIdentity: agencyPost };
      }
      delete file.runBindings[runId];
      await this.#save(file);
    });
  }

  async undo(checkpointId?: string, options: { allowDeletes?: boolean } = {}): Promise<UndoResult> {
    const plan = await this.prepareUndo(checkpointId);
    return this.applyUndo(plan, options);
  }

  async prepareUndo(checkpointId?: string): Promise<UndoPlan> {
    await this.#ensureControlDirectory();
    const checkpoints = (await this.#load()).checkpoints;
    const checkpoint = checkpointId === undefined
      ? checkpoints.at(-1)
      : checkpoints.find(({ id, ref }) => id === checkpointId || ref === checkpointId);
    if (checkpoint === undefined) throw this.#missing(checkpointId ?? "latest");
    const token = randomUUID();
    const materializationRoot = join(this.root, ".devagency", "undo-plans", token);
    await mkdir(materializationRoot, { recursive: true, mode: 0o700 });
    const result: UndoPlan = {
      checkpointId: checkpoint.id,
      restored: [], diverged: [], unchanged: [], deletionsRequired: [],
      token, entries: [], materializationRoot,
    };
    try {
      if ((await this.#git(["cat-file", "-t", checkpoint.tree], true))?.trim() !== "tree") {
        throw new InfrastructureError("GIT_CHECKPOINT_INVALID", `Checkpoint tree ${checkpoint.tree} is unavailable`);
      }
      let index = 0;
      for (const [path, snapshot] of Object.entries(checkpoint.paths).sort(([a], [b]) => a.localeCompare(b))) {
        if (!("postAgencyIdentity" in snapshot)) continue;
        const current = await identity(this.root, path);
        if (current !== snapshot.postAgencyIdentity) result.diverged.push(path);
        else if (snapshot.checkpointIdentity === snapshot.postAgencyIdentity) result.unchanged.push(path);
        else if (snapshot.checkpointIdentity === null) {
          if (current !== null) result.deletionsRequired.push(path);
          result.entries.push({ path, expectedIdentity: current, checkpointIdentity: null });
        } else {
          const modeLine = (await this.#git(["ls-tree", checkpoint.tree, "--", path]))?.trim();
          const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\t/u.exec(modeLine ?? "");
          if (match === null || (await this.#git(["cat-file", "-t", match[2]!], true))?.trim() !== "blob") {
            throw new InfrastructureError("GIT_CHECKPOINT_INVALID", `Invalid checkpoint blob for ${path}`);
          }
          const mode = match[1] as "100644" | "100755" | "120000";
          const content = await this.#gitBuffer(["cat-file", "blob", match[2]!]);
          const materializedPath = join(materializationRoot, String(index++));
          if (mode === "120000") await symlink(content.toString("utf8"), materializedPath);
          else await writeFile(materializedPath, content, { mode: mode === "100755" ? 0o755 : 0o644 });
          result.entries.push({ path, expectedIdentity: current, checkpointIdentity: snapshot.checkpointIdentity, materializedPath, mode });
        }
      }
      return result;
    } catch (cause) {
      await rm(materializationRoot, { recursive: true, force: true });
      throw cause;
    }
  }

  async applyUndo(plan: UndoPlan, options: { allowDeletes?: boolean } = {}): Promise<UndoResult> {
    this.#validateUndoPlan(plan);
    const applied: Array<{ absolute: string; backup: string; hadOriginal: boolean; appliedIdentity: string | null }> = [];
    try {
      if (plan.deletionsRequired.length > 0 && options.allowDeletes !== true) {
        throw new InfrastructureError("GIT_DESTRUCTIVE_CONFIRMATION_REQUIRED", `Undo would delete ${plan.deletionsRequired.length} path(s): ${plan.deletionsRequired.map((path) => JSON.stringify(path)).join(", ")}`);
      }
      for (const entry of plan.entries) {
        const absolute = await validatePath(this.root, entry.path);
        if (entry.checkpointIdentity !== null) {
          if (entry.materializedPath === undefined || await this.#materializedIdentity(entry.materializedPath) !== entry.checkpointIdentity) {
            throw new InfrastructureError("GIT_CHECKPOINT_INVALID", `Undo materialization changed for ${entry.path}`);
          }
        }
        if (await identity(this.root, entry.path) !== entry.expectedIdentity) {
          plan.diverged.push(entry.path);
          continue;
        }
        await mkdir(dirname(absolute), { recursive: true });
        await validatePath(this.root, entry.path);
        if (await identity(this.root, entry.path) !== entry.expectedIdentity) {
          plan.diverged.push(entry.path);
          continue;
        }
        const backup = `${absolute}.agency-undo-${plan.token}.bak`;
        try {
          await lstat(backup);
          throw unsafePath(`Undo backup path already exists for ${entry.path}`);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        const hadOriginal = entry.expectedIdentity !== null;
        if (hadOriginal) {
          await rename(absolute, backup);
          const backupRelative = relative(this.root, backup);
          if (await identity(this.root, backupRelative) !== entry.expectedIdentity) {
            await link(backup, absolute).then(() => rm(backup)).catch(() => {});
            throw new InfrastructureError("GIT_CHECKPOINT_INVALID", `Target changed during undo for ${entry.path}; backup preserved if no-replace restoration was unsafe`);
          }
        }
        try {
          if (entry.checkpointIdentity === null) {
            // Renaming to backup is the reversible deletion.
          } else {
            if (entry.materializedPath === undefined) throw new Error(`Missing materialization for ${entry.path}`);
            if (entry.expectedIdentity === null) {
              await link(entry.materializedPath, absolute);
              await rm(entry.materializedPath);
            } else await rename(entry.materializedPath, absolute);
          }
          applied.push({ absolute, backup, hadOriginal, appliedIdentity: entry.checkpointIdentity });
          await this.#afterInstall?.(entry.path);
          if (await identity(this.root, entry.path) !== entry.checkpointIdentity) {
            throw new InfrastructureError("GIT_CHECKPOINT_INVALID", `Installed undo identity mismatch for ${entry.path}`);
          }
          plan.restored.push(entry.path);
        } catch (cause) {
          if (hadOriginal) await link(backup, absolute).then(() => rm(backup)).catch(() => {});
          throw cause;
        }
      }
      for (const { backup, hadOriginal } of applied) if (hadOriginal) await rm(backup, { force: true }).catch(() => {});
      return { checkpointId: plan.checkpointId, restored: plan.restored, diverged: [...new Set(plan.diverged)].sort(), unchanged: plan.unchanged, deletionsRequired: plan.deletionsRequired };
    } catch (cause) {
      const rollbackFailures: string[] = [];
      for (const { absolute, backup, hadOriginal, appliedIdentity } of applied.reverse()) {
        try {
          const current = await identity(this.root, relative(this.root, absolute));
          if (current !== appliedIdentity) {
            rollbackFailures.push(`${relative(this.root, absolute)}: target changed after undo mutation; left untouched`);
            continue;
          }
          await rm(absolute, { force: true });
          if (hadOriginal) {
            await link(backup, absolute);
            await rm(backup);
          }
        } catch (rollbackError) {
          rollbackFailures.push(`${relative(this.root, absolute)}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (cause instanceof InfrastructureError && cause.code === "GIT_DESTRUCTIVE_CONFIRMATION_REQUIRED") throw cause;
      throw new InfrastructureError("GIT_CHECKPOINT_INVALID", rollbackFailures.length === 0 ? "Undo failed; prior path changes were rolled back" : `Undo failed; partial rollback failures preserved backups: ${rollbackFailures.join("; ")}`, { cause });
    } finally {
      await rm(plan.materializationRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async discardUndoPlan(plan: UndoPlan): Promise<void> {
    this.#validateUndoPlan(plan);
    await rm(plan.materializationRoot, { recursive: true, force: true });
  }

  #validateUndoPlan(plan: UndoPlan): void {
    if (!/^[0-9a-f-]{36}$/u.test(plan.token) || resolve(plan.materializationRoot) !== resolve(this.root, ".devagency", "undo-plans", plan.token)) {
      throw unsafePath("Undo plan materialization root is invalid");
    }
    for (const entry of plan.entries) {
      if (entry.materializedPath !== undefined && dirname(resolve(entry.materializedPath)) !== resolve(plan.materializationRoot)) {
        throw unsafePath(`Undo materialization escapes its plan: ${entry.path}`);
      }
    }
  }

  async #materializedIdentity(path: string): Promise<string | null> {
    const stats = await lstat(path);
    const executable = stats.mode & 0o111;
    if (stats.isSymbolicLink()) {
      const target = await readlink(path);
      return `symlink:${executable}:${Buffer.byteLength(target)}:${createHash("sha256").update(target).digest("hex")}`;
    }
    if (!stats.isFile()) return null;
    const bytes = await readFile(path);
    return `file:${executable}:${bytes.byteLength}:${createHash("sha256").update(bytes).digest("hex")}`;
  }

  async #snapshotWorkingTree(): Promise<{ tree: string; identities: Record<string, string | null> }> {
    const output = await this.#git(["ls-files", "-co", "--exclude-standard", "-z"]);
    const paths = [...new Set((output ?? "").split("\0").filter(Boolean))]
      .filter((path) => path !== ".devagency" && !path.startsWith(".devagency/") && path !== ".agency-worktrees" && !path.startsWith(".agency-worktrees/"))
      .sort();
    if (paths.length > MAX_PATHS) throw new InfrastructureError("GIT_CHECKPOINT_INVALID", `Checkpoint exceeds ${MAX_PATHS} paths`);
    const entries: Buffer[] = [];
    const identities: Record<string, string | null> = {};
    for (const path of paths) {
      await validatePath(this.root, path);
      const captured = capturePathExact(this.root, path);
      if (captured === null) continue;
      const oid = (await this.#gitBuffer(["hash-object", "-w", "--stdin"], captured.content)).toString("utf8").trim();
      entries.push(Buffer.from(`${captured.mode} ${oid}\t${path}\0`));
      identities[path] = captured.identity;
    }
    const temporary = await mkdtemp(join(tmpdir(), "agency-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(temporary, "index") };
      await this.#git(["read-tree", "--empty"], false, env);
      if (entries.length > 0) await this.#gitBuffer(["update-index", "-z", "--index-info"], Buffer.concat(entries), env);
      const tree = (await this.#git(["write-tree"], false, env))!.trim();
      return { tree, identities };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async #load(): Promise<CheckpointFile> {
    try {
      const contents = await readFile(this.#metadataPath, "utf8");
      if (Buffer.byteLength(contents) > 8 * 1024 * 1024) throw new Error("metadata exceeds 8 MiB");
      const parsed = JSON.parse(contents) as Partial<CheckpointFile>;
      if (parsed.version !== METADATA_VERSION || !Array.isArray(parsed.checkpoints) || parsed.checkpoints.length > MAX_CHECKPOINTS) {
        throw new Error("invalid shape");
      }
      parsed.runBindings ??= {};
      if (typeof parsed.runBindings !== "object" || parsed.runBindings === null || Object.keys(parsed.runBindings).length > 100) throw new Error("invalid run bindings");
      for (const [runId, binding] of Object.entries(parsed.runBindings)) {
        if (!/^[A-Za-z0-9._-]{1,128}$/u.test(runId) || typeof binding !== "object" || binding === null || typeof binding.checkpointId !== "string" || typeof binding.preRunIdentities !== "object" || binding.preRunIdentities === null || typeof binding.agencyPostIdentities !== "object" || binding.agencyPostIdentities === null || Object.keys(binding.preRunIdentities).length > MAX_PATHS || Object.keys(binding.agencyPostIdentities).length > MAX_PATHS) throw new Error("invalid run binding");
        for (const [path, value] of [...Object.entries(binding.preRunIdentities), ...Object.entries(binding.agencyPostIdentities)]) {
          if (path.length > 1_024 || (value !== null && (typeof value !== "string" || value.length > 256))) throw new Error("invalid run identity");
        }
      }
      for (const checkpoint of parsed.checkpoints) {
        if (
          typeof checkpoint !== "object" || checkpoint === null ||
          !/^[a-z0-9-]{1,64}$/u.test(checkpoint.id) ||
          checkpoint.ref !== `refs/agency/checkpoints/${checkpoint.id}` ||
          !/^[0-9a-f]{40,64}$/u.test(checkpoint.tree) ||
          !/^[0-9a-f]{40,64}$/u.test(checkpoint.commit) ||
          (checkpoint.baseHead !== null && !/^[0-9a-f]{40,64}$/u.test(checkpoint.baseHead)) ||
          typeof checkpoint.createdAt !== "string" || !Number.isFinite(Date.parse(checkpoint.createdAt)) ||
          (checkpoint.label !== undefined && (typeof checkpoint.label !== "string" || checkpoint.label.length > 200)) ||
          typeof checkpoint.paths !== "object" || checkpoint.paths === null ||
          Object.keys(checkpoint.paths).length > MAX_PATHS
        ) throw new Error("invalid checkpoint entry");
        for (const [path, metadata] of Object.entries(checkpoint.paths)) {
          if (path.length > 1_024 || typeof metadata !== "object" || metadata === null) throw new Error("invalid path entry");
          for (const value of [metadata.checkpointIdentity, metadata.postAgencyIdentity]) {
            if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 256)) throw new Error("invalid identity");
          }
        }
      }
      return parsed as CheckpointFile;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { version: METADATA_VERSION, checkpoints: [], runBindings: {} };
      throw new InfrastructureError("GIT_CHECKPOINT_INVALID", `Invalid checkpoint metadata at ${this.#metadataPath}`, { cause });
    }
  }

  async #save(file: CheckpointFile): Promise<void> {
    await mkdir(dirname(this.#metadataPath), { recursive: true });
    const temporary = `${this.#metadataPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temporary, this.#metadataPath);
  }

  #missing(id: string): InfrastructureError {
    return new InfrastructureError("GIT_CHECKPOINT_NOT_FOUND", `No Agency checkpoint matches ${id}`);
  }

  async #git(args: string[], allowFailure = false, env?: NodeJS.ProcessEnv): Promise<string | null> {
    const result = await runCommand({ command: "git", args, cwd: this.root, env: { ...process.env, ...env }, timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 });
    if (result.exitCode === 0) return result.stdout;
    if (allowFailure) return null;
    throw new InfrastructureError("GIT_COMMAND_FAILED", result.stderr.trim() || `git ${args.join(" ")} failed`);
  }

  async #gitBuffer(args: string[], input?: Buffer, env?: NodeJS.ProcessEnv): Promise<Buffer> {
    if (input !== undefined) {
      return new Promise<Buffer>((resolvePromise, reject) => {
        const child = spawn("git", args, { cwd: this.root, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", reject);
        child.on("close", (code) => code === 0
          ? resolvePromise(Buffer.concat(stdout))
          : reject(new InfrastructureError("GIT_COMMAND_FAILED", Buffer.concat(stderr).toString("utf8").trim() || `git ${args.join(" ")} failed`)));
        child.stdin.end(input);
      });
    }
    return new Promise<Buffer>((resolvePromise, reject) => {
      execFile("git", args, {
        cwd: this.root,
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
      }, (error, stdout, stderr) => {
        if (error !== null) {
          reject(new InfrastructureError("GIT_COMMAND_FAILED", Buffer.from(stderr).toString("utf8").trim() || `git ${args.join(" ")} failed`, { cause: error }));
        } else resolvePromise(Buffer.from(stdout));
      });
    });
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withRepositoryLock(this.root, operation);
  }

  async #ensureControlDirectory(): Promise<void> {
    const directory = dirname(this.#metadataPath);
    await mkdir(directory, { recursive: true });
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw unsafePath("Agency metadata directory must be a real contained directory");
  }
}
