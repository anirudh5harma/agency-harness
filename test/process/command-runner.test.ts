import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { runCommand } from "../../src/process/index.js";
import { terminatePosixProcessGroup } from "../../src/process/command-runner.js";

async function waitForPid(path: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for child PID at ${path}`);
}

describe("runCommand", () => {
  it.skipIf(process.platform === "win32")(
    "fails deterministically when a process group survives the termination deadline",
    async () => {
      let now = 0;
      const signals: NodeJS.Signals[] = [];

      await expect(
        terminatePosixProcessGroup(1234, {
          now: () => now,
          delay: async (milliseconds) => {
            now += milliseconds;
          },
          kill: (_pid, signal) => {
            if (signal !== 0) signals.push(signal);
          },
          forceAfterMs: 20,
          deadlineMs: 50,
          pollIntervalMs: 10,
        }),
      ).rejects.toMatchObject({
        name: "InfrastructureError",
        code: "COMMAND_TERMINATION_FAILED",
      });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    },
  );

  it("rejects spawn failures as typed infrastructure errors", async () => {
    await expect(
      runCommand({
        command: `agency-command-that-does-not-exist-${process.pid}`,
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "COMMAND_SPAWN_FAILED",
    });
  });

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

  it.skipIf(process.platform === "win32")(
    "aborts, terminates descendants, and waits for their shutdown",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "agency-process-tree-"));
      const pidPath = join(directory, "grandchild.pid");
      const controller = new AbortController();
      let command: ReturnType<typeof runCommand> | undefined;
      try {
        command = runCommand({
          command: "/bin/sh",
          args: [
            "-c",
            `sleep 60 & echo $! > ${JSON.stringify(pidPath)}; wait`,
          ],
          cwd: process.cwd(),
          signal: controller.signal,
          timeoutMs: 10_000,
        });
        void command.catch(() => undefined);
        const grandchildPid = await waitForPid(pidPath);
        controller.abort();
        const result = await command;

        expect(result.timedOut).toBe(false);
        expect(result.signal).toBe("SIGTERM");
        expect(() => process.kill(grandchildPid, 0)).toThrow();
      } finally {
        controller.abort();
        await command?.catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

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

  it("preserves the exact head and tail across many small chunks", async () => {
    const chunks = Array.from({ length: 20_000 }, (_, index) =>
      String(index % 10),
    ).join("");
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", `for (const byte of ${JSON.stringify(chunks)}) process.stdout.write(byte)`],
      cwd: process.cwd(),
      maxOutputBytes: 160,
    });
    const marker = "\n… output truncated …\n";
    const contentLimit = 160 - Buffer.byteLength(marker);
    const headLimit = Math.ceil(contentLimit / 2);
    const tailLimit = Math.floor(contentLimit / 2);

    expect(result.stdout).toBe(
      chunks.slice(0, headLimit) + marker + chunks.slice(-tailLimit),
    );
  });
});
