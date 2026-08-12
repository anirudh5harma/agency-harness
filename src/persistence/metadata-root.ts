import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const METADATA_DIRECTORY_MODE = 0o700;
const METADATA_FILE_MODE = 0o600;

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
    await validatePrivateMetadataFile(projectRoot, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export const PRIVATE_METADATA_FILE_MODE = METADATA_FILE_MODE;
