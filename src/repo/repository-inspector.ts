import { access, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import type { ProjectMetadata, RepoContext } from "../domain/index.js";
import { InfrastructureError, runCommand } from "../process/index.js";

const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md", "CODEX.md"] as const;

export interface RepositoryInspection extends RepoContext {
  porcelain: string;
  instructionFiles: string[];
  packageJsonPath: string | null;
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  packageManager?: unknown;
  scripts?: unknown;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  const result = await runCommand({ command: "git", args, cwd, timeoutMs: 15_000 });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function findGitRoot(cwd: string): Promise<string> {
  const root = await gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null || root === "") {
    throw new InfrastructureError(
      "NOT_GIT_REPOSITORY",
      `No Git repository contains ${resolve(cwd)}`,
    );
  }
  return root;
}

async function readProjectMetadata(rootPath: string): Promise<{
  packageJsonPath: string | null;
  project: ProjectMetadata;
}> {
  const packageJsonPath = join(rootPath, "package.json");
  let manifest: PackageManifest = {};
  if (await exists(packageJsonPath)) {
    try {
      manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageManifest;
    } catch (cause) {
      throw new InfrastructureError(
        "PACKAGE_METADATA_INVALID",
        `Invalid package metadata at ${packageJsonPath}`,
        { cause },
      );
    }
  }

  const scripts = Object.fromEntries(
    Object.entries(
      manifest.scripts !== null && typeof manifest.scripts === "object"
        ? (manifest.scripts as Record<string, unknown>)
        : {},
    ).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].trim() !== "",
    ),
  );
  const languages: string[] = [];
  if (await exists(join(rootPath, "tsconfig.json"))) languages.push("TypeScript");
  else if (packageJsonPath !== null && (await exists(packageJsonPath))) {
    languages.push("JavaScript");
  }

  let packageManager =
    typeof manifest.packageManager === "string" && manifest.packageManager.trim() !== ""
      ? manifest.packageManager
      : undefined;
  if (packageManager === undefined) {
    if (await exists(join(rootPath, "pnpm-lock.yaml"))) packageManager = "pnpm";
    else if (await exists(join(rootPath, "yarn.lock"))) packageManager = "yarn";
    else if (await exists(join(rootPath, "bun.lock"))) packageManager = "bun";
    else if (await exists(join(rootPath, "package-lock.json"))) packageManager = "npm";
  }

  return {
    packageJsonPath: (await exists(packageJsonPath)) ? packageJsonPath : null,
    project: {
      name:
        typeof manifest.name === "string" && manifest.name.trim() !== ""
          ? manifest.name
          : basename(rootPath),
      ...(typeof manifest.version === "string" && manifest.version.trim() !== ""
        ? { version: manifest.version }
        : {}),
      ...(typeof manifest.description === "string" &&
      manifest.description.trim() !== ""
        ? { description: manifest.description }
        : {}),
      languages,
      ...(packageManager === undefined ? {} : { packageManager }),
      scripts,
    },
  };
}

async function findInstructionFiles(
  rootPath: string,
  requestedPath: string,
): Promise<string[]> {
  const resolvedRequestedPath = resolve(requestedPath);
  const relativePath = relative(rootPath, resolvedRequestedPath);
  const withinRoot =
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
  const directories = [rootPath];
  if (withinRoot && relativePath !== "") {
    let current = rootPath;
    for (const segment of relativePath.split(sep)) {
      current = join(current, segment);
      directories.push(current);
    }
  }

  const candidates = [
    ...directories.flatMap((directory) =>
      INSTRUCTION_FILE_NAMES.map((name) => join(directory, name)),
    ),
    join(rootPath, ".github", "copilot-instructions.md"),
  ];
  const present = await Promise.all(
    candidates.map(async (path) => ((await exists(path)) ? path : null)),
  );
  return present.filter((path): path is string => path !== null);
}

export async function inspectRepository(
  cwd: string,
): Promise<RepositoryInspection> {
  const rootPath = await findGitRoot(cwd);
  const [branch, porcelain, defaultBranchReference, metadata, instructionFiles] =
    await Promise.all([
      gitOutput(rootPath, ["branch", "--show-current"]),
      gitOutput(rootPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
      gitOutput(rootPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
      readProjectMetadata(rootPath),
      findInstructionFiles(rootPath, cwd),
    ]);

  if (porcelain === null) {
    throw new InfrastructureError(
      "GIT_COMMAND_FAILED",
      `Could not inspect Git status in ${rootPath}`,
    );
  }

  return {
    rootPath,
    currentBranch: branch === null || branch === "" ? null : branch,
    defaultBranch: defaultBranchReference?.replace(/^origin\//, "") ?? null,
    isDirty: porcelain !== "",
    project: metadata.project,
    porcelain,
    instructionFiles,
    packageJsonPath: metadata.packageJsonPath,
  };
}
