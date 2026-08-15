import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const METADATA_DIRECTORY_MODE = 0o700;
const METADATA_FILE_MODE = 0o600;
const metadataFileLocks = new Map<string, Promise<void>>();

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

async function removeAbandonedLock(projectRoot: string, lockPath: string): Promise<void> {
  let contents: string;
  try {
    contents = await readPrivateMetadataFile(projectRoot, lockPath, 1024) ?? "";
  } catch {
    return;
  }
  const match = /^pid=(\d+)\ncreated=(\d+)\n$/.exec(contents);
  const pid = Number(match?.[1]);
  const createdAt = Number(match?.[2]);
  const validOwner = Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(createdAt);
  const abandoned = validOwner
    ? Date.now() - createdAt > 24 * 60 * 60 * 1_000 || !processIsAlive(pid)
    : (Date.now() - (await lstat(lockPath)).mtimeMs) > 10_000;
  if (!abandoned) return;
  const stalePath = `${lockPath}.${randomUUID()}.stale`;
  try {
    await rename(lockPath, stalePath);
    await rm(stalePath, { force: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

async function acquireMetadataFileLock(projectRoot: string, path: string): Promise<() => Promise<void>> {
  await ensurePrivateMetadataDirectory(projectRoot, dirname(path));
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        METADATA_FILE_MODE,
      );
      try {
        await handle.writeFile(`pid=${process.pid}\ncreated=${Date.now()}\n`);
        await handle.sync();
      } catch (cause) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        throw cause;
      }
      return async () => {
        try {
          await handle.close();
        } finally {
          await rm(lockPath, { force: true });
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
