import { appendFile, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { InfrastructureError, runCommand } from "../process/index.js";

export const AGENCY_LOCAL_EXCLUDE_RULE = ".devagency/";
export const AGENCY_WORKTREE_EXCLUDE_RULE = ".agency-worktrees/";

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
  await ensureLocalExcludeRules(rootPath, [AGENCY_LOCAL_EXCLUDE_RULE]);
}

export async function ensureLocalExcludeRules(
  rootPath: string,
  rules: readonly string[],
): Promise<void> {
  let excludePath: string;
  try {
    excludePath = await resolveGitExcludePath(rootPath);
    const contents = await readFile(excludePath, "utf8");
    const existing = new Set(contents.split(/\r?\n/u));
    const missing = rules.filter((rule) => !existing.has(rule));
    if (missing.length === 0) return;
    const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    await appendFile(excludePath, `${prefix}${missing.join("\n")}\n`, "utf8");
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
