import { describe, expect, it } from "vitest";

import { runCommand } from "../../src/process/index.js";

describe("runCommand", () => {
  it("returns structured success and failure results", async () => {
    const success = await runCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      cwd: process.cwd(),
    });
    const failure = await runCommand({
      command: process.execPath,
      args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
      cwd: process.cwd(),
    });

    expect(success).toMatchObject({ exitCode: 0, stdout: "ok", timedOut: false });
    expect(success.durationMs).toBeGreaterThanOrEqual(0);
    expect(failure).toMatchObject({ exitCode: 7, stderr: "bad", timedOut: false });
  });

  it("times out and terminates a long-running child", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      cwd: process.cwd(),
      timeoutMs: 30,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      cwd: process.cwd(),
      signal: controller.signal,
    });

    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(false);
  });

  it("bounds output while preserving its beginning and useful tail", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('BEGIN-' + 'x'.repeat(10_000) + '-TAIL')",
      ],
      cwd: process.cwd(),
      maxOutputBytes: 160,
    });

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(240);
    expect(result.stdout).toContain("BEGIN-");
    expect(result.stdout).toContain("-TAIL");
    expect(result.stdout).toContain("output truncated");
  });
});
