import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import type { CommandResult } from "../domain/index.js";

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
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #totalBytes = 0;

  constructor(readonly limit: number) {
    const contentLimit = Math.max(0, limit - TRUNCATION_MARKER.byteLength);
    this.#headLimit = Math.ceil(contentLimit / 2);
    this.#tailLimit = Math.floor(contentLimit / 2);
  }

  append(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#totalBytes += bytes.byteLength;

    if (this.#head.byteLength < this.#headLimit) {
      const missing = this.#headLimit - this.#head.byteLength;
      this.#head = Buffer.concat([this.#head, bytes.subarray(0, missing)]);
    }

    if (this.#tailLimit > 0) {
      const combined = Buffer.concat([this.#tail, bytes]);
      this.#tail = combined.subarray(
        Math.max(0, combined.byteLength - this.#tailLimit),
      );
    }
  }

  toString(): string {
    if (this.#totalBytes <= this.#headLimit) return this.#head.toString("utf8");
    if (this.#totalBytes <= this.limit) {
      const overlap = this.#head.byteLength + this.#tail.byteLength - this.#totalBytes;
      return Buffer.concat([
        this.#head,
        this.#tail.subarray(Math.max(0, overlap)),
      ]).toString("utf8");
    }
    return Buffer.concat([this.#head, TRUNCATION_MARKER, this.#tail]).toString(
      "utf8",
    );
  }
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

  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;

    const terminate = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => child.kill("SIGKILL"), 250);
        forceKill.unref();
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
    child.on("error", (error) => stderr.append(`${error.message}\n`));
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
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
