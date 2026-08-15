import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandResult } from "../../src/domain/index.js";
import { EventBus } from "../../src/events/index.js";
import {
  VerificationRunner,
  detectNodeVerificationConfiguration,
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

  it("reads bounded required verification environment key names from package metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "agency-verify-"));
    directories.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest" },
        agency: { requiredVerificationEnvironmentKeys: ["TEST_DATABASE_URL", "FEATURE_FLAG"] },
      }),
    );

    await expect(detectNodeVerificationConfiguration(root)).resolves.toEqual({
      commands: [{ name: "test", command: "npm", args: ["run", "test"], required: true }],
      requiredEnvironmentKeys: ["FEATURE_FLAG", "TEST_DATABASE_URL"],
    });
  });

  it("rejects malformed required verification environment configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "agency-verify-"));
    directories.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest" },
        agency: { requiredVerificationEnvironmentKeys: ["DATABASE_URL=secret"] },
      }),
    );

    await expect(detectNodeVerificationConfiguration(root)).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "PACKAGE_METADATA_INVALID",
    });
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

  it("redacts command output before returning a failed verification result", async () => {
    const execute = vi.fn(async (command: VerificationCommand) => ({
      ...result(command, 1),
      stdout: "Bearer bearer-secret-value token=plain-token-value",
      stderr: "AKIAIOSFODNN7EXAMPLE ghp_abcdefghijklmnopqrstuvwxyz123456",
    }));
    const runner = new VerificationRunner({ execute });

    const verification = await runner.run(commands.slice(0, 1), process.cwd());

    expect(JSON.stringify(verification)).not.toMatch(
      /bearer-secret-value|plain-token-value|AKIAIOSFODNN7EXAMPLE|ghp_abcdefghijklmnopqrstuvwxyz123456/u,
    );
    expect(JSON.stringify(verification)).toContain("[REDACTED]");
  });

  it("runs verification with a minimal environment that excludes credentials", async () => {
    const execute = vi.fn(async (command: VerificationCommand) => result(command, 0));
    const runner = new VerificationRunner({
      execute,
      environment: {
        PATH: "/safe/bin",
        HOME: "/safe/home",
        OPENAI_API_KEY: "sk-providerSecret123",
        AWS_SECRET_ACCESS_KEY: "aws-secret-value",
        GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      },
    });

    await runner.run(commands.slice(0, 1), process.cwd());

    const options = execute.mock.calls[0]?.[1];
    expect(options?.env).toEqual({ PATH: "/safe/bin", HOME: "/safe/home" });
    expect(options?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(options?.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(options?.env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("reports limited verification when explicitly required project environment is stripped", async () => {
    const execute = vi.fn(async (command: VerificationCommand) => result(command, 0));
    const runner = new VerificationRunner({
      execute,
      environment: {
        PATH: "/safe/bin",
        DATABASE_URL: "postgres://owner:secret@localhost/app",
      },
      requiredEnvironmentKeys: ["DATABASE_URL"],
    });

    const verification = await runner.run(commands.slice(0, 1), process.cwd());

    expect(execute).not.toHaveBeenCalled();
    expect(verification).toEqual({
      status: "skipped",
      summary: "Verification environment is missing required keys: DATABASE_URL",
      commands: [],
    });
    expect(JSON.stringify(verification)).not.toContain("owner:secret");
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
