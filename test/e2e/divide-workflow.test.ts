import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { runAgency, type TerminalIO, type TextOutput } from "../../src/cli/index.js";
import { FakeCodingRuntime } from "../../src/coding/index.js";
import type { Plan } from "../../src/domain/index.js";
import { EventBus } from "../../src/events/index.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureRoot = join(projectRoot, "fixtures", "divide");
const temporaryDirectories: string[] = [];

class BufferOutput implements TextOutput {
  value = "";
  write(text: string): void {
    this.value += text;
  }
}

class ScriptedIO implements TerminalIO {
  readonly prompts: string[] = [];

  constructor(private readonly lines: Array<string | null>) {}

  async readLine(prompt: string): Promise<string | null> {
    this.prompts.push(prompt);
    return this.lines.shift() ?? null;
  }

  onInterrupt(): () => void {
    return () => {};
  }

  close(): void {}
}

const firstPlan: Plan = {
  objective: "Reject division by zero",
  assumptions: [],
  steps: [
    { id: "test", description: "Cover division by zero" },
    { id: "code", description: "Reject a zero divisor" },
  ],
  likelyFiles: ["src/divide.ts", "test/divide.test.ts"],
  verificationStrategy: ["Run tests and typecheck"],
};

const secondPlan: Plan = {
  objective: "Use a custom division-by-zero error",
  assumptions: [],
  steps: [
    { id: "error", description: "Add and throw DivisionByZeroError" },
    { id: "test", description: "Assert the custom error type" },
  ],
  likelyFiles: ["src/divide.ts", "test/divide.test.ts"],
  verificationStrategy: ["Run tests and typecheck"],
};

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

async function copyFixture(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "agency-divide-e2e-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "divide");
  await cp(fixtureRoot, root, { recursive: true });
  await symlink(join(projectRoot, "node_modules"), join(root, "node_modules"), "dir");
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "agency@example.com"]);
  await git(root, ["config", "user.name", "Agency E2E"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "fixture baseline"]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("divide fixture end to end", () => {
  it("runs two real conversational workflows around only a fake Pi boundary", async () => {
    const cwd = await copyFixture();
    const runtime = new FakeCodingRuntime();
    runtime.enqueuePlanResult({ plan: firstPlan, message: "planned zero guard" });
    runtime.enqueueExecuteResult({
      message: "added a zero guard and its regression test",
      changedFiles: ["not-trusted.ts"],
      sessionId: "fake-pi-one",
    });
    runtime.enqueuePlanResult({ plan: secondPlan, message: "planned custom error" });
    runtime.enqueueExecuteResult({
      message: "introduced DivisionByZeroError",
      changedFiles: ["also-not-trusted.ts"],
      sessionId: "fake-pi-two",
    });

    let execution = 0;
    let firstTurnSource = "";
    let firstTurnTests = "";
    runtime.execute = async (input) => {
      const result = await FakeCodingRuntime.prototype.execute.call(runtime, input);
      execution += 1;
      if (execution === 1) {
        await writeFile(
          join(cwd, "src", "divide.ts"),
          [
            "export function divide(a: number, b: number): number {",
            "  if (b === 0) throw new Error(\"Division by zero\");",
            "  return a / b;",
            "}",
            "",
          ].join("\n"),
        );
        await writeFile(
          join(cwd, "test", "divide.test.ts"),
          [
            'import assert from "node:assert/strict";',
            'import test from "node:test";',
            "",
            'import { divide } from "../src/divide.ts";',
            "",
            'test("divides two numbers", () => {',
            "  assert.equal(divide(6, 3), 2);",
            "});",
            "",
            'test("rejects division by zero", () => {',
            '  assert.throws(() => divide(1, 0), /Division by zero/);',
            "});",
            "",
          ].join("\n"),
        );
        firstTurnSource = await readFile(join(cwd, "src", "divide.ts"), "utf8");
        firstTurnTests = await readFile(join(cwd, "test", "divide.test.ts"), "utf8");
      } else {
        await writeFile(
          join(cwd, "src", "divide.ts"),
          [
            "export class DivisionByZeroError extends Error {",
            '  override readonly name = "DivisionByZeroError";',
            "}",
            "",
            "export function divide(a: number, b: number): number {",
            '  if (b === 0) throw new DivisionByZeroError("Division by zero");',
            "  return a / b;",
            "}",
            "",
          ].join("\n"),
        );
        await writeFile(
          join(cwd, "test", "divide.test.ts"),
          [
            'import assert from "node:assert/strict";',
            'import test from "node:test";',
            "",
            'import { divide, DivisionByZeroError } from "../src/divide.ts";',
            "",
            'test("divides two numbers", () => {',
            "  assert.equal(divide(6, 3), 2);",
            "});",
            "",
            'test("rejects division by zero with the domain error", () => {',
            "  assert.throws(() => divide(1, 0), DivisionByZeroError);",
            "});",
            "",
          ].join("\n"),
        );
      }
      return result;
    };

    const io = new ScriptedIO([
      "Make divide reject a zero divisor and add tests.",
      "Replace the generic Error with a custom DivisionByZeroError.",
      "/status",
      "/exit",
    ]);
    const output = new BufferOutput();
    const errors = new BufferOutput();
    const eventBus = new EventBus();
    const phases: string[] = [];
    const commandExitCodes: number[] = [];
    eventBus.subscribe("phase", ({ phase }) => phases.push(phase));
    eventBus.subscribe("command_finished", ({ exitCode }) => commandExitCodes.push(exitCode));
    let nextId = 0;

    await runAgency({
      cwd,
      io,
      output,
      errorOutput: errors,
      runtimeFactory: async () => runtime,
      eventBusFactory: () => eventBus,
      createId: () => `e2e-${++nextId}`,
    });

    expect(errors.value).toBe("");
    expect(io.prompts).toEqual(["agency> ", "agency> ", "agency> ", "agency> "]);
    expect(runtime.calls.createPlan).toHaveLength(2);
    expect(runtime.calls.execute).toHaveLength(2);
    expect(runtime.calls.createPlan[1]?.sessionContext).toMatchObject({
      recentTurns: [
        { role: "user", content: "Make divide reject a zero divisor and add tests." },
        { role: "user", content: "Replace the generic Error with a custom DivisionByZeroError." },
      ],
      runSummaries: [{ status: "completed", objective: firstPlan.objective }],
    });
    expect(JSON.stringify(runtime.calls.createPlan[1]?.sessionContext).length).toBeLessThan(8_000);
    expect(phases).toEqual([
      "preparing", "planning", "executing", "verifying",
      "preparing", "planning", "executing", "verifying",
    ]);
    expect(commandExitCodes).toEqual([0, 0, 0, 0]);
    expect(firstTurnSource).toContain('throw new Error("Division by zero")');
    expect(firstTurnSource).not.toContain("DivisionByZeroError");
    expect(firstTurnTests).toContain("rejects division by zero");

    const source = await readFile(join(cwd, "src", "divide.ts"), "utf8");
    const tests = await readFile(join(cwd, "test", "divide.test.ts"), "utf8");
    const diff = await git(cwd, ["diff", "--", "src/divide.ts", "test/divide.test.ts"]);
    expect(source).toContain("class DivisionByZeroError extends Error");
    expect(source).toContain("throw new DivisionByZeroError");
    expect(tests).toContain("DivisionByZeroError");
    expect(diff).toContain("+export class DivisionByZeroError extends Error");
    expect(diff).toContain("+  assert.throws(() => divide(1, 0), DivisionByZeroError);");

    const session = JSON.parse(await readFile(join(cwd, ".devagency", "session.json"), "utf8")) as {
      runSummaries: Array<{ status: string; verification: { commands: Array<{ exitCode: number }> } }>;
    };
    expect(session.runSummaries).toHaveLength(2);
    expect(session.runSummaries.map(({ status }) => status)).toEqual(["completed", "completed"]);
    expect(session.runSummaries.flatMap(({ verification }) =>
      verification.commands.map(({ exitCode }) => exitCode))).toEqual([0, 0, 0, 0]);
    expect(output.value).toContain(`Last task: ${secondPlan.objective}`);
    expect(output.value).toContain("Status: completed");
    expect(output.value).toContain("Verification: passed");

    for (const runId of ["e2e-1", "e2e-3"]) {
      const trajectory = await readFile(join(cwd, ".devagency", "runs", `${runId}.jsonl`), "utf8");
      expect(trajectory).toContain('"event":"run_started"');
      expect(trajectory).toContain('"event":"verification_passed"');
      expect(trajectory).toContain('"event":"run_completed"');
    }
    const database = new DatabaseSync(join(cwd, ".devagency", "state.db"), { readOnly: true });
    try {
      const checkpointCount = database.prepare("SELECT count(*) AS count FROM checkpoints").get() as {
        count: number;
      };
      expect(checkpointCount.count).toBe(0);
    } finally {
      database.close();
    }
  }, 30_000);
});
