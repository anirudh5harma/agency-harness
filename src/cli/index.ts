#!/usr/bin/env node

import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AgencyApplication, type AgencyApplicationDependencies } from "./application.js";
import { ReadlineTerminalIO } from "./repl.js";
import { POLICY_DISPLAY } from "../coding/tool-policy.js";
import {
  defaultNpmRunner,
  getUpdateCachePath,
  getUpdateStatus,
  isUpdateAvailable,
  readPackageMetadata,
  readUpdateCache,
  runUpdate,
} from "./update.js";
import {
  agencyWorktreeDirty,
  createAgencyWorktree,
  discardAgencyWorktree,
  findAgencyWorktree,
  type AgencyWorktreeContext,
} from "../repo/index.js";

export * from "./application.js";
export * from "./commands.js";
export * from "./renderer.js";
export * from "./repl.js";
export * from "./update.js";

export async function runAgency(
  dependencies: AgencyApplicationDependencies,
): Promise<void> {
  let application: AgencyApplication | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    application = await AgencyApplication.create(dependencies);
    await application.run();
  } catch (error) {
    primaryError = error;
  }
  try {
    if (application === undefined) dependencies.io.close();
    else await application.dispose();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([primaryError, cleanupError], "Agency run and cleanup failed");
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}

export interface CliArguments {
  help: boolean;
  policy: boolean;
  version: boolean;
  worktree: boolean;
  update: { checkOnly: boolean } | null;
}

export const CLI_USAGE = "Usage: agency [--worktree] [--policy] [--version] [--help]\n       agency update [--check]";

export function parseCliArguments(args: readonly string[]): CliArguments {
  let help = false;
  let policy = false;
  let version = false;
  let worktree = false;
  if (args[0] === "update") {
    let checkOnly = false;
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--check") checkOnly = true;
      else if (argument === "--help" || argument === "-h") help = true;
      else throw new Error(`Unknown update option: ${argument ?? ""}. ${CLI_USAGE}`);
    }
    return { help, policy, version, worktree, update: { checkOnly } };
  }
  for (const argument of args) {
    if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--policy") policy = true;
    else if (argument === "--version" || argument === "-v") version = true;
    else if (argument === "--worktree") worktree = true;
    else throw new Error(`Unknown option: ${argument}. ${CLI_USAGE}`);
  }
  return { help, policy, version, worktree, update: null };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArguments(args);
  if (options.help) {
    process.stdout.write(`${CLI_USAGE}\n\n--worktree  Run in a preserved isolated Git worktree.\n--policy    Show enforced tool policy and sandbox status.\n--version   Show the installed Agency version.\n`);
    return;
  }
  const metadata = await readPackageMetadata();
  if (options.version) {
    process.stdout.write(`agency ${metadata.version}\n`);
    return;
  }
  if (options.update !== null) {
    if (options.update.checkOnly) {
      const status = await getUpdateStatus(metadata, { useCache: false, writeCache: false });
      process.stdout.write(status.updateAvailable
        ? `Agency ${status.availableVersion} is available. Run: agency update\n`
        : `Agency ${metadata.version} is current.\n`);
      return;
    }
    await runUpdate({ packageName: metadata.name, run: defaultNpmRunner });
    process.stdout.write("Agency update completed. Run agency --version to confirm.\n");
    return;
  }
  if (options.policy) {
    process.stdout.write(`${POLICY_DISPLAY}\n`);
    return;
  }
  if (process.stderr.isTTY === true && process.env.AGENCY_DISABLE_UPDATE_CHECK !== "1") {
    const cachePath = getUpdateCachePath();
    const cached = await readUpdateCache(cachePath);
    const availableVersion = cached?.version;
    if (availableVersion !== null && availableVersion !== undefined
        && isUpdateAvailable(metadata.version, availableVersion)) {
      process.stderr.write(`Agency ${availableVersion} is available. Run: agency update\n`);
    } else if (cached === undefined) {
      void getUpdateStatus(metadata, { cachePath, timeoutMs: 1_500 })
        .catch(() => undefined);
    }
  }
  let context: AgencyWorktreeContext | undefined;
  let discard: { dirty: boolean } | undefined;
  if (options.worktree) {
    context = await createAgencyWorktree(process.cwd());
    process.stdout.write(`Agency worktree: ${context.path}\nBranch: ${context.branch}\nPreserved unless /worktree discard is confirmed.\n`);
  } else context = await findAgencyWorktree(process.cwd()) ?? undefined;
  const io = new ReadlineTerminalIO(process.stdin, process.stdout);
  const worktree = context === undefined ? undefined : {
    context,
    requestDiscard: async (signal: AbortSignal): Promise<boolean> => {
      const dirty = await agencyWorktreeDirty(context!);
      const expected = dirty ? "discard dirty" : "discard";
      const answer = await io.readLine(
        dirty
          ? `Worktree has changes. Type '${expected}' to permanently discard files and branch: `
          : `Type '${expected}' to remove worktree and branch: `,
        { signal },
      );
      if (answer?.trim().toLowerCase() !== expected) {
        process.stdout.write("Worktree discard cancelled; it remains preserved.\n");
        return false;
      }
      discard = { dirty };
      return true;
    },
  };
  await runAgency({
    cwd: context?.path ?? process.cwd(),
    io,
    output: process.stdout,
    errorOutput: process.stderr,
    ...(worktree === undefined ? {} : { worktree }),
  });
  if (context !== undefined && discard !== undefined) {
    await discardAgencyWorktree(context, { confirmed: true, discardDirty: discard.dirty });
    process.stdout.write(`Discarded Agency worktree ${context.path} and branch ${context.branch}.\n`);
  }
}

export function isMainModule(entry = process.argv[1]): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Agency could not start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
