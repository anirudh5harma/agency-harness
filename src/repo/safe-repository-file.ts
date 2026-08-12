import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { InfrastructureError } from "../process/index.js";

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function safeFile(rootPath: string, filePath: string): Promise<{ root: string; path: string } | null> {
  const lexicalRoot = resolve(rootPath);
  const lexicalPath = resolve(filePath);
  if (!within(lexicalRoot, lexicalPath) || lexicalPath === lexicalRoot) {
    throw new Error("path is outside the repository");
  }
  const root = await realpath(rootPath);
  const path = resolve(root, relative(lexicalRoot, lexicalPath));
  let cursor = root;
  for (const segment of relative(root, path).split(sep)) {
    cursor = resolve(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
    if (info.isSymbolicLink()) throw new Error("symbolic links are not allowed");
    if (cursor === path) {
      if (!info.isFile() || info.nlink !== 1) throw new Error("instruction must be a single-link regular file");
    } else if (!info.isDirectory()) {
      throw new Error("instruction parent must be a real directory");
    }
  }
  if (!within(root, await realpath(path))) throw new Error("instruction resolves outside the repository");
  return { root, path };
}

function instructionError(rootPath: string, filePath: string, cause: unknown): InfrastructureError {
  const label = relative(rootPath, filePath).split(sep).join("/");
  return new InfrastructureError(
    "METADATA_READ_FAILED",
    `Unsafe or unreadable repository instructions at ${label}`,
    { cause },
  );
}

export async function safeRepositoryFileExists(rootPath: string, filePath: string): Promise<boolean> {
  try {
    return (await safeFile(rootPath, filePath)) !== null;
  } catch (cause) {
    throw instructionError(rootPath, filePath, cause);
  }
}

export async function readSafeRepositoryFile(
  rootPath: string,
  filePath: string,
  maxBytes: number,
): Promise<string> {
  let checked;
  try {
    checked = await safeFile(rootPath, filePath);
    if (checked === null) throw new Error("instruction file does not exist");
    const handle = await open(checked.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw new Error("instruction must be a single-link regular file");
      const buffer = Buffer.alloc(Math.min(maxBytes, Number(before.size)));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const named = await lstat(checked.path, { bigint: true });
      if (
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || named.dev !== after.dev || named.ino !== after.ino ||
        named.isSymbolicLink()
      ) throw new Error("instruction file changed while it was read");
      return buffer.subarray(0, offset).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (cause) {
    throw instructionError(rootPath, filePath, cause);
  }
}
