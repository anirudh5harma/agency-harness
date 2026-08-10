import { appendFile, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { InfrastructureError, runCommand } from "../process/index.js";

export const AGENCY_LOCAL_EXCLUDE_RULE = ".devagency/";

export async function resolveGitExcludePath(rootPath: string): Promise<string> {
  const result = await runCommand({
    command: "git",
    args: ["rev-parse", "--git-path", "info/exclude"],
    cwd: rootPath,
    timeoutMs: 15_000,
  });
  const output = result.stdout.trim();
  if (result.exitCode !== 0 || output === "") {
    throw new InfrastructureError(
      "GIT_EXCLUDE_SETUP_FAILED",
      `Could not resolve the repository-local Git exclude file in ${rootPath}`,
      { cause: result.stderr.trim() || undefined },
    );
  }
  return isAbsolute(output) ? output : resolve(rootPath, output);
}

export async function ensureAgencyMetadataIgnored(rootPath: string): Promise<void> {
  let excludePath: string;
  try {
    excludePath = await resolveGitExcludePath(rootPath);
    const contents = await readFile(excludePath, "utf8");
    if (contents.split(/\r?\n/u).includes(AGENCY_LOCAL_EXCLUDE_RULE)) return;
    const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    await appendFile(excludePath, `${prefix}${AGENCY_LOCAL_EXCLUDE_RULE}\n`, "utf8");
  } catch (cause) {
    if (
      cause instanceof InfrastructureError &&
      cause.code === "GIT_EXCLUDE_SETUP_FAILED"
    ) {
      throw cause;
    }
    throw new InfrastructureError(
      "GIT_EXCLUDE_SETUP_FAILED",
      `Could not configure the repository-local Git exclude file in ${rootPath}`,
      { cause },
    );
  }
}
