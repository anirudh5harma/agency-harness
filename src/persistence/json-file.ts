import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ZodType } from "zod";

import { InfrastructureError } from "../process/infrastructure-error.js";

export function isMissingFile(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function readJsonFile<T>(
  path: string,
  schema: ZodType<T>,
): Promise<T | null> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw new InfrastructureError(
      "METADATA_READ_FAILED",
      `Could not read project metadata at ${path}`,
      { cause },
    );
  }

  try {
    return schema.parse(JSON.parse(contents));
  } catch (cause) {
    throw new InfrastructureError(
      "METADATA_INVALID",
      `Invalid project metadata at ${path}`,
      { cause },
    );
  }
}

export async function writeJsonFileAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new InfrastructureError(
      "METADATA_WRITE_FAILED",
      `Could not write project metadata at ${path}`,
      { cause },
    );
  }
}
