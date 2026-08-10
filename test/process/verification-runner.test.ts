import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandResult } from "../../src/domain/index.js";
import { EventBus } from "../../src/events/index.js";
import {
  VerificationRunner,
  detectNodeVerificationCommands,
  type VerificationCommand,
} from "../../src/process/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("detectNodeVerificationCommands", () => {
  it("returns existing scripts only in deterministic verification order", async () => {
    const root = await mkdtemp(join(tmpdir(), "agency-verify-"));
    directories.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", test: "vitest", lint: "eslint ." } }),
    );

    await expect(detectNodeVerificationCommands(root)).resolves.toEqual([
      { name: "test", command: "npm", args: ["run", "test"], required: true },
      { name: "lint", command: "npm", args: ["run", "lint"], required: true },
      { name: "build", command: "npm", args: ["run", "build"], required: true },
    ]);
  });
});

describe("VerificationRunner", () => {
  const commands: VerificationCommand[] = [
    { name: "test", command: "npm", args: ["run", "test"], required: true },
    { name: "lint", command: "npm", args: ["run", "lint"], required: true },
  ];

  function result(command: VerificationCommand, exitCode: number): CommandResult {
    return {
      command: command.command,
      args: command.args,
      exitCode,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    };
  }

  it("runs sequentially and emits command events", async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe("command_started", (event) => events.push(`start:${event.command}`));
    bus.subscribe("command_finished", (event) => events.push(`end:${event.command}`));
    const execute = vi.fn(async (command: VerificationCommand) => result(command, 0));
    const runner = new VerificationRunner({ eventBus: bus, execute });

    const verification = await runner.run(commands, process.cwd());

    expect(verification.status).toBe("passed");
    expect(execute.mock.calls.map(([command]) => command.name)).toEqual(["test", "lint"]);
    expect(events).toEqual([
      "start:npm run test",
      "end:npm run test",
      "start:npm run lint",
      "end:npm run lint",
    ]);
  });

  it("stops after the first required nonzero exit code", async () => {
    const execute = vi.fn(async (command: VerificationCommand) => result(command, 2));
    const runner = new VerificationRunner({ execute });

    const verification = await runner.run(commands, process.cwd());

    expect(verification.status).toBe("failed");
    expect(verification.commands).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates command spawn failures instead of reporting verification failure", async () => {
    const runner = new VerificationRunner();

    await expect(
      runner.run(
        [
          {
            name: "test",
            command: `agency-command-that-does-not-exist-${process.pid}`,
            args: [],
            required: true,
          },
        ],
        process.cwd(),
      ),
    ).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "COMMAND_SPAWN_FAILED",
    });
  });
});
