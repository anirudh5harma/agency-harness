#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgencyApplication, type AgencyApplicationDependencies } from "./application.js";
import { ReadlineTerminalIO } from "./repl.js";
import { POLICY_DISPLAY } from "../coding/tool-policy.js";
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

export async function runAgency(
  dependencies: AgencyApplicationDependencies,
): Promise<void> {
  let application: AgencyApplication | undefined;
  try {
    application = await AgencyApplication.create(dependencies);
    await application.run();
  } finally {
    if (application === undefined) dependencies.io.close();
    else await application.dispose();
  }
}

export interface CliArguments {
  help: boolean;
  policy: boolean;
  worktree: boolean;
}

export const CLI_USAGE = "Usage: agency [--worktree] [--policy] [--help]";

export function parseCliArguments(args: readonly string[]): CliArguments {
  let help = false;
  let policy = false;
  let worktree = false;
  for (const argument of args) {
    if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--policy") policy = true;
    else if (argument === "--worktree") worktree = true;
    else throw new Error(`Unknown option: ${argument}. ${CLI_USAGE}`);
  }
  return { help, policy, worktree };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArguments(args);
  if (options.help) {
    process.stdout.write(`${CLI_USAGE}\n\n--worktree  Run in a preserved isolated Git worktree.\n--policy    Show enforced tool policy and sandbox status.\n`);
    return;
  }
  if (options.policy) {
    process.stdout.write(`${POLICY_DISPLAY}\n`);
    return;
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

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Agency could not start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
