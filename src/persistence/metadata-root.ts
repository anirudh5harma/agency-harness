import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const METADATA_DIRECTORY_MODE = 0o700;
const METADATA_FILE_MODE = 0o600;
const MAX_LOCK_BYTES = 4 * 1024;
const MALFORMED_LOCK_GRACE_MS = 30_000;
const PROCESS_START_ID = randomUUID();
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1_000);
const metadataFileLocks = new Map<string, Promise<void>>();

interface MetadataFileLease {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
  readonly processStartId: string;
}

async function hardenDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) throw new Error("metadata directories must be real directories");
    await handle.chmod(METADATA_DIRECTORY_MODE);
  } finally {
    await handle.close();
  }
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function ensurePrivateMetadataDirectory(
  projectRoot: string,
  directory = resolve(projectRoot, ".devagency"),
): Promise<string> {
  const lexicalProject = resolve(projectRoot);
  const lexicalMetadataRoot = resolve(lexicalProject, ".devagency");
  const lexicalTarget = resolve(directory);
  if (!within(lexicalMetadataRoot, lexicalTarget)) throw new Error("metadata path escapes .devagency");
  const canonicalProject = await realpath(projectRoot);
  const metadataRoot = resolve(canonicalProject, ".devagency");
  const target = resolve(metadataRoot, relative(lexicalMetadataRoot, lexicalTarget));

  let cursor = metadataRoot;
  for (const segment of ["", ...relative(metadataRoot, target).split(sep).filter(Boolean)]) {
    if (segment !== "") cursor = resolve(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("metadata directories must be real directories");
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      await mkdir(cursor, { mode: METADATA_DIRECTORY_MODE }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const created = await lstat(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("metadata directory creation was replaced", { cause });
      }
    }
    await hardenDirectory(cursor);
  }
  if (await realpath(metadataRoot) !== metadataRoot) throw new Error("metadata root resolves outside the project");
  return target;
}

export async function validatePrivateMetadataFile(projectRoot: string, path: string): Promise<boolean> {
  await ensurePrivateMetadataDirectory(projectRoot, dirname(path));
  let info;
  try {
    info = await lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error("metadata files must be single-link regular files");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1) throw new Error("metadata files must be single-link regular files");
    await handle.chmod(METADATA_FILE_MODE);
  } finally {
    await handle.close();
  }
  return true;
}

export async function readPrivateMetadataFile(
  projectRoot: string,
  path: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<string | null> {
  if (!(await validatePrivateMetadataFile(projectRoot, path))) return null;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
      throw new Error("metadata file is not a bounded single-link regular file");
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error("metadata file changed while it was read");
    }
    return contents;
  } finally {
    await handle.close();
  }
}

export async function writePrivateMetadataFileAtomic(
  projectRoot: string,
  path: string,
  contents: string | Buffer,
): Promise<void> {
  await ensurePrivateMetadataDirectory(projectRoot, dirname(path));
  await validatePrivateMetadataFile(projectRoot, path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      METADATA_FILE_MODE,
    );
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await validatePrivateMetadataFile(projectRoot, temporary);
    await validatePrivateMetadataFile(projectRoot, path);
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw cause;
      } finally {
        await directory.close();
      }
    }
    await validatePrivateMetadataFile(projectRoot, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseMetadataFileLease(contents: string): MetadataFileLease | null {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const lease = value as Partial<MetadataFileLease>;
  if (
    !Number.isSafeInteger(lease.pid)
    || (lease.pid ?? 0) <= 0
    || !Number.isSafeInteger(lease.createdAt)
    || typeof lease.token !== "string"
    || lease.token.length === 0
    || typeof lease.processStartId !== "string"
    || lease.processStartId.length === 0
  ) return null;
  return lease as MetadataFileLease;
}

function leaseOwnerIsGone(lease: MetadataFileLease): boolean {
  if (!processIsAlive(lease.pid)) return true;
  return lease.pid === process.pid
    && lease.processStartId !== PROCESS_START_ID
    && lease.createdAt < PROCESS_STARTED_AT;
}

async function restoreQuarantinedLock(quarantinePath: string, lockPath: string): Promise<void> {
  try {
    await link(quarantinePath, lockPath);
    await rm(quarantinePath, { force: true });
  } catch {
    // A new canonical lease won the race. Preserve the displaced lease for diagnosis.
  }
}

async function removeAbandonedLock(projectRoot: string, lockPath: string): Promise<void> {
  let observedBytes: string;
  try {
    observedBytes = await readPrivateMetadataFile(projectRoot, lockPath, MAX_LOCK_BYTES) ?? "";
  } catch {
    return;
  }
  const observed = parseMetadataFileLease(observedBytes);
  if (observed !== null && !leaseOwnerIsGone(observed)) return;
  if (observed === null) {
    try {
      if (Date.now() - (await lstat(lockPath)).mtimeMs <= MALFORMED_LOCK_GRACE_MS) return;
    } catch {
      return;
    }
  }

  const quarantinePath = `${lockPath}.${randomUUID()}.stale`;
  let quarantined = false;
  try {
    await rename(lockPath, quarantinePath);
    quarantined = true;
    const movedBytes = await readPrivateMetadataFile(projectRoot, quarantinePath, MAX_LOCK_BYTES) ?? "";
    const moved = parseMetadataFileLease(movedBytes);
    const unchangedLease = observed !== null
      && moved !== null
      && movedBytes === observedBytes
      && moved.token === observed.token
      && leaseOwnerIsGone(moved);
    const unchangedMalformed = observed === null
      && moved === null
      && movedBytes === observedBytes
      && Date.now() - (await lstat(quarantinePath)).mtimeMs > MALFORMED_LOCK_GRACE_MS;
    if (unchangedLease || unchangedMalformed) {
      await rm(quarantinePath, { force: true });
      quarantined = false;
    } else {
      await restoreQuarantinedLock(quarantinePath, lockPath);
      quarantined = false;
    }
  } catch (cause) {
    if (quarantined) await restoreQuarantinedLock(quarantinePath, lockPath);
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

async function acquireMetadataFileLock(projectRoot: string, path: string): Promise<() => Promise<void>> {
  await ensurePrivateMetadataDirectory(projectRoot, dirname(path));
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  const lease: MetadataFileLease = {
    pid: process.pid,
    token,
    createdAt: Date.now(),
    processStartId: PROCESS_START_ID,
  };
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        METADATA_FILE_MODE,
      );
      try {
        await handle.writeFile(JSON.stringify(lease));
        await handle.sync();
      } catch (cause) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw cause;
      }
      await handle.close();
      return async () => {
        const quarantinePath = `${lockPath}.${randomUUID()}.release`;
        let quarantined = false;
        try {
          await rename(lockPath, quarantinePath);
          quarantined = true;
          const movedBytes = await readPrivateMetadataFile(projectRoot, quarantinePath, MAX_LOCK_BYTES);
          const moved = movedBytes === null ? null : parseMetadataFileLease(movedBytes);
          if (moved?.token === token) {
            await rm(quarantinePath, { force: true });
            quarantined = false;
          } else {
            await restoreQuarantinedLock(quarantinePath, lockPath);
            quarantined = false;
          }
        } catch {
          if (quarantined) await restoreQuarantinedLock(quarantinePath, lockPath);
          // Never unlink a lease whose token cannot be proven to be ours.
        }
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      await removeAbandonedLock(projectRoot, lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for metadata lock ${lockPath}`, { cause });
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
}

export async function withPrivateMetadataFileLock<T>(
  projectRoot: string,
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockKey = resolve(path);
  const previous = metadataFileLocks.get(lockKey) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolveQueued) => {
    releaseQueue = resolveQueued;
  });
  const tail = previous.then(() => queued, () => queued);
  metadataFileLocks.set(lockKey, tail);
  await previous.catch(() => undefined);
  let releaseFile: (() => Promise<void>) | undefined;
  try {
    releaseFile = await acquireMetadataFileLock(projectRoot, path);
    return await operation();
  } finally {
    try {
      await releaseFile?.();
    } finally {
      releaseQueue();
      if (metadataFileLocks.get(lockKey) === tail) metadataFileLocks.delete(lockKey);
    }
  }
}

export const PRIVATE_METADATA_FILE_MODE = METADATA_FILE_MODE;
