import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandResult, VerificationResult } from "../domain/index.js";
import type { EventBus } from "../events/index.js";
import { runCommand, type RunCommandOptions } from "./command-runner.js";
import { InfrastructureError } from "./infrastructure-error.js";

const VERIFICATION_ORDER = ["test", "typecheck", "lint", "build"] as const;

export interface VerificationCommand {
  name: (typeof VERIFICATION_ORDER)[number] | string;
  command: string;
  args: string[];
  required: boolean;
}

type CommandExecutor = (
  command: VerificationCommand,
  options: Omit<RunCommandOptions, "command" | "args" | "cwd"> & {
    cwd: string;
  },
) => Promise<CommandResult>;

export interface VerificationRunnerOptions {
  eventBus?: EventBus;
  execute?: CommandExecutor;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

interface PackageManifest {
  packageManager?: unknown;
  scripts?: unknown;
}

function packageRunner(packageManager: unknown): string {
  if (typeof packageManager !== "string") return "npm";
  const name = packageManager.split("@", 1)[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

export async function detectNodeVerificationCommands(
  cwd: string,
): Promise<VerificationCommand[]> {
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as PackageManifest;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === "ENOENT") return [];
    throw new InfrastructureError(
      "PACKAGE_METADATA_INVALID",
      `Could not read package metadata at ${join(cwd, "package.json")}`,
      { cause },
    );
  }

  const scripts =
    manifest.scripts !== null && typeof manifest.scripts === "object"
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  const runner = packageRunner(manifest.packageManager);

  return VERIFICATION_ORDER.filter(
    (name) => typeof scripts[name] === "string" && scripts[name].trim() !== "",
  ).map((name) => ({
    name,
    command: runner,
    args: ["run", name],
    required: true,
  }));
}

export class VerificationRunner {
  readonly #eventBus: EventBus | undefined;
  readonly #execute: CommandExecutor;
  readonly #options: Omit<RunCommandOptions, "command" | "args" | "cwd">;

  constructor(options: VerificationRunnerOptions = {}) {
    this.#eventBus = options.eventBus;
    this.#execute =
      options.execute ??
      ((command, runOptions) =>
        runCommand({
          ...runOptions,
          command: command.command,
          args: command.args,
        }));
    this.#options = {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
  }

  async run(
    commands: readonly VerificationCommand[],
    cwd: string,
  ): Promise<VerificationResult> {
    if (commands.length === 0) {
      return { status: "skipped", summary: "No verification commands detected", commands: [] };
    }

    const results: CommandResult[] = [];
    for (const command of commands) {
      const displayCommand = [command.command, ...command.args].join(" ");
      this.#eventBus?.emit({ type: "command_started", command: displayCommand });
      const result = await this.#execute(command, { ...this.#options, cwd });
      results.push(result);
      this.#eventBus?.emit({
        type: "command_finished",
        command: displayCommand,
        exitCode: result.exitCode ?? -1,
        durationMs: result.durationMs,
      });

      if (command.required && result.exitCode !== 0) {
        return {
          status: "failed",
          summary: `${command.name} failed with exit code ${result.exitCode ?? "none"}`,
          commands: results,
        };
      }
    }

    return {
      status: "passed",
      summary: `${results.length} verification command${results.length === 1 ? "" : "s"} passed`,
      commands: results,
    };
  }
}
