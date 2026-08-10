import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runAgency, type TerminalIO, type TextOutput } from "../src/cli/index.js";
import { FakeCodingRuntime } from "../src/coding/index.js";
import type { Plan } from "../src/domain/index.js";
import { resolveGitExcludePath } from "../src/repo/index.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const builtCliPath = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const temporaryDirectories: string[] = [];

class BufferOutput implements TextOutput {
  value = "";
  write(text: string): void {
    this.value += text;
  }
}

class ScriptedIO implements TerminalIO {
  readonly prompts: string[] = [];
  closeCalls = 0;

  constructor(private readonly lines: Array<string | null>) {}

  async readLine(prompt: string): Promise<string | null> {
    this.prompts.push(prompt);
    return this.lines.shift() ?? null;
  }

  onInterrupt(): () => void {
    return () => {};
  }

  close(): void {
    this.closeCalls += 1;
  }
}

const plan: Plan = {
  objective: "Make the requested change",
  assumptions: [],
  steps: [{ id: "1", description: "Update the project" }],
  likelyFiles: [],
  verificationStrategy: ["Run tests"],
};

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function temporaryGitProject(options: { verification?: boolean } = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agency-cli-"));
  temporaryDirectories.push(directory);
  await git(directory, ["init", "-q"]);
  await git(directory, ["config", "user.email", "agency@example.com"]);
  await git(directory, ["config", "user.name", "Agency Test"]);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: options.verification
        ? { test: "node -e \"console.log('verified')\"" }
        : {},
    }),
  );
  await writeFile(join(directory, "tracked.txt"), "initial\n");
  await git(directory, ["add", "package.json", "tracked.txt"]);
  await git(directory, ["commit", "-qm", "initial"]);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Agency terminal application", () => {
  it("keeps a clean repository clean after repeated metadata startup", async () => {
    const cwd = await temporaryGitProject();
    const beforeIgnore = await readFile(join(cwd, ".gitignore"), "utf8").catch(
      () => null,
    );

    for (let startup = 0; startup < 2; startup += 1) {
      await runAgency({
        cwd,
        io: new ScriptedIO(["/exit"]),
        output: new BufferOutput(),
        errorOutput: new BufferOutput(),
        runtimeFactory: async () => new FakeCodingRuntime(),
      });
    }

    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd },
    );
    const exclude = await readFile(await resolveGitExcludePath(cwd), "utf8");
    expect(stdout).toBe("");
    expect(exclude.split(/\r?\n/u).filter((line) => line === ".devagency/"))
      .toHaveLength(1);
    expect(await readFile(join(cwd, ".gitignore"), "utf8").catch(() => null))
      .toBe(beforeIgnore);
  });

  it("keeps two natural-language turns in one REPL and session", async () => {
    const cwd = await temporaryGitProject();
    const runtime = new FakeCodingRuntime();
    for (const suffix of ["one", "two"]) {
      runtime.enqueuePlanResult({ plan, message: `plan ${suffix}` });
      runtime.enqueueExecuteResult({ message: `done ${suffix}`, changedFiles: [], sessionId: "pi" });
    }
    const io = new ScriptedIO(["first task", "follow-up task", "/exit"]);
    const output = new BufferOutput();
    const errors = new BufferOutput();
    let nextId = 0;

    await runAgency({
      cwd,
      io,
      output,
      errorOutput: errors,
      runtimeFactory: async () => runtime,
      createId: () => `id-${++nextId}`,
    });

    expect(runtime.calls.createPlan).toHaveLength(2);
    expect(runtime.calls.createPlan[1]?.sessionContext?.recentTurns.map(({ content }) => content))
      .toEqual(["first task", "follow-up task"]);
    expect(runtime.calls.createPlan[0]?.sessionContext?.sessionId)
      .toBe(runtime.calls.createPlan[1]?.sessionContext?.sessionId);
    expect(io.prompts.filter((prompt) => prompt === "agency> ")).toHaveLength(3);
    expect(output.value).toContain("Done:");
    expect(errors.value).toBe("");
    expect(runtime.isDisposed).toBe(true);
    expect(io.closeCalls).toBe(1);
    expect(await readFile(join(cwd, ".devagency", "runs", "id-1.jsonl"), "utf8"))
      .toContain('"event":"run_started"');
    expect(await readFile(join(cwd, ".devagency", "runs", "id-3.jsonl"), "utf8"))
      .toContain('"event":"run_completed"');
  }, 10_000);

  it("routes slash commands without invoking the coding runtime and starts a new session", async () => {
    const cwd = await temporaryGitProject({ verification: true });
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
    const runtime = new FakeCodingRuntime();
    const io = new ScriptedIO([
      "/help",
      "/status",
      "/diff",
      "/verify",
      "/new",
      "/status",
      "/wat",
      "/exit",
    ]);
    const output = new BufferOutput();
    const errors = new BufferOutput();

    await runAgency({ cwd, io, output, errorOutput: errors, runtimeFactory: async () => runtime });

    expect(runtime.calls.createPlan).toHaveLength(0);
    expect(runtime.calls.execute).toHaveLength(0);
    expect(output.value).toContain("Commands:");
    expect(output.value).toContain("-initial");
    expect(output.value).toContain("+changed");
    expect(output.value).toContain("Verification: passed");
    const sessions = [...output.value.matchAll(/Session: ([^\n]+)/g)].map((match) => match[1]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).not.toBe(sessions[1]);
    expect(errors.value).toContain("Unknown command: /wat");
  });

  it("renders a failed graph run truthfully and returns to the prompt", async () => {
    const cwd = await temporaryGitProject();
    const runtime = new FakeCodingRuntime();
    runtime.enqueuePlanResult(new Error("planner unavailable"));
    const io = new ScriptedIO(["do something", "/exit"]);
    const output = new BufferOutput();
    const errors = new BufferOutput();

    await runAgency({ cwd, io, output, errorOutput: errors, runtimeFactory: async () => runtime });

    expect(errors.value).toContain("Failed: Run failed: planner unavailable");
    expect(output.value).not.toContain("Done:");
    expect(io.prompts.filter((prompt) => prompt === "agency> ")).toHaveLength(2);
  });

  it("fails clearly and nonzero when started outside Git", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agency-outside-git-"));
    temporaryDirectories.push(cwd);
    await execFileAsync("npm", ["run", "build"], { cwd: projectRoot });
    const error = await execFileAsync(process.execPath, [builtCliPath], { cwd }).catch(
      (cause: unknown) => cause as { code: number; stderr: string },
    );

    expect(error.code).not.toBe(0);
    expect(error.stderr).toContain("Agency could not start: No Git repository contains");
  });
});
