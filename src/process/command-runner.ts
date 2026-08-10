import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import type { CommandResult } from "../domain/index.js";
import { InfrastructureError } from "./infrastructure-error.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const TRUNCATION_MARKER = Buffer.from("\n… output truncated …\n");

export interface RunCommandOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}

class BoundedOutput {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  readonly #head: Buffer[] = [];
  readonly #tail: Buffer[] = [];
  #tailStart = 0;
  #headBytes = 0;
  #tailBytes = 0;
  #totalBytes = 0;

  constructor(readonly limit: number) {
    const contentLimit = Math.max(0, limit - TRUNCATION_MARKER.byteLength);
    this.#headLimit = Math.ceil(contentLimit / 2);
    this.#tailLimit = Math.floor(contentLimit / 2);
  }

  append(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#totalBytes += bytes.byteLength;

    if (this.#headBytes < this.#headLimit) {
      const retained = bytes.subarray(0, this.#headLimit - this.#headBytes);
      if (retained.byteLength > 0) {
        this.#head.push(Buffer.from(retained));
        this.#headBytes += retained.byteLength;
      }
    }

    if (this.#tailLimit > 0) {
      const retained =
        bytes.byteLength > this.#tailLimit
          ? Buffer.from(bytes.subarray(bytes.byteLength - this.#tailLimit))
          : bytes;
      this.#tail.push(retained);
      this.#tailBytes += retained.byteLength;
      while (this.#tailBytes > this.#tailLimit) {
        const first = this.#tail[this.#tailStart];
        if (first === undefined) break;
        const excess = this.#tailBytes - this.#tailLimit;
        if (first.byteLength <= excess) {
          this.#tailStart += 1;
          this.#tailBytes -= first.byteLength;
        } else {
          this.#tail[this.#tailStart] = Buffer.from(first.subarray(excess));
          this.#tailBytes -= excess;
        }
      }
      if (this.#tailStart > 1_024 && this.#tailStart * 2 > this.#tail.length) {
        this.#tail.splice(0, this.#tailStart);
        this.#tailStart = 0;
      }
    }
  }

  toString(): string {
    const head = Buffer.concat(this.#head, this.#headBytes);
    if (this.#totalBytes <= this.#headLimit) return head.toString("utf8");
    const tail = Buffer.concat(
      this.#tail.slice(this.#tailStart),
      this.#tailBytes,
    );
    if (this.#totalBytes <= this.limit) {
      const overlap = head.byteLength + tail.byteLength - this.#totalBytes;
      return Buffer.concat([
        head,
        tail.subarray(Math.max(0, overlap)),
      ]).toString("utf8");
    }
    return Buffer.concat([head, TRUNCATION_MARKER, tail]).toString(
      "utf8",
    );
  }
}

interface PosixTerminationOptions {
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  forceAfterMs?: number;
  deadlineMs?: number;
  pollIntervalMs?: number;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const stopWaitingAt = performance.now() + 2_000;
  while (processExists(pid) && performance.now() < stopWaitingAt) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (processExists(pid)) {
    throw new InfrastructureError(
      "COMMAND_TERMINATION_FAILED",
      `Process ${pid} survived its termination deadline`,
    );
  }
}

/** @internal Exported only to permit deterministic termination failure tests. */
export async function terminatePosixProcessGroup(
  pid: number,
  options: PosixTerminationOptions = {},
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const delay =
    options.delay ??
    (async (milliseconds: number) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
  const kill = options.kill ?? ((target, signal) => process.kill(target, signal));
  const forceAfterMs = options.forceAfterMs ?? 250;
  const deadlineMs = options.deadlineMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 10;
  const groupExists = (): boolean => {
    try {
      kill(-pid, 0);
      return true;
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  try {
    kill(-pid, "SIGTERM");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    return;
  }

  const forceAt = now() + forceAfterMs;
  const stopWaitingAt = now() + deadlineMs;
  let forced = false;
  while (groupExists() && now() < stopWaitingAt) {
    if (!forced && now() >= forceAt) {
      forced = true;
      try {
        kill(-pid, "SIGKILL");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      }
    }
    await delay(pollIntervalMs);
  }

  if (groupExists()) {
    throw new InfrastructureError(
      "COMMAND_TERMINATION_FAILED",
      `Process group ${pid} survived its termination deadline`,
    );
  }
}

async function terminateProcessTree(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => {
        child.kill();
        resolve();
      });
      killer.once("close", (exitCode) => {
        if (exitCode !== 0) child.kill();
        resolve();
      });
    });
    await waitForProcessExit(child.pid);
    return;
  }

  await terminatePosixProcessGroup(child.pid);
}

export async function runCommand(
  options: RunCommandOptions,
): Promise<CommandResult> {
  if (options.cwd.trim() === "") throw new TypeError("runCommand requires cwd");
  const args = [...(options.args ?? [])];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 64) {
    throw new RangeError("maxOutputBytes must be an integer of at least 64");
  }

  const stdout = new BoundedOutput(maxOutputBytes);
  const stderr = new BoundedOutput(maxOutputBytes);
  const startedAt = performance.now();
  let timedOut = false;

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let settled = false;
    let termination: Promise<void> | undefined;

    const terminate = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        termination ??= terminateProcessTree(child);
      }
    };
    const onAbort = (): void => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) terminate();

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      reject(
        new InfrastructureError(
          "COMMAND_SPAWN_FAILED",
          `Could not start command: ${options.command}`,
          { cause },
        ),
      );
    });
    child.on("close", async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        await termination;
      } catch (cause) {
        reject(
          new InfrastructureError(
            "COMMAND_TERMINATION_FAILED",
            `Could not terminate command: ${options.command}`,
            { cause },
          ),
        );
        return;
      }
      resolve({
        command: options.command,
        args,
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        durationMs: performance.now() - startedAt,
        timedOut,
      });
    });
  });
}
