import { link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  POLICY_DISPLAY,
  MissionMutationBudget,
  ROLE_TOOL_POLICY,
  assertAllowedBash,
  bashApprovalAction,
  createProtectedBashTool,
  createRoleFileTools,
  defaultToolFactoryBoundary,
} from "../../src/coding/index.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "agency-policy-root-"));
  const outside = await mkdtemp(join(tmpdir(), "agency-policy-outside-"));
  temporaryDirectories.push(root, outside);
  await mkdir(join(root, "src"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, ".devagency"));
  await writeFile(join(root, "src", "safe.ts"), "export const safe = true;\n");
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, ".git", "config"), "secret\n");
  await writeFile(join(root, ".devagency", "checkpoint.json"), "private\n");
  await writeFile(join(outside, "secret.txt"), "outside-secret\n");
  await symlink(join(outside, "secret.txt"), join(root, "outside-link"));
  await symlink(outside, join(root, "outside-dir"));
  await symlink(outside, join(root, "src", "nested-outside"));
  await symlink(join(root, ".git", "config"), join(root, "private-alias"));
  return { root, outside };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function invoke(tool: ReturnType<typeof createRoleFileTools>[number], params: unknown) {
  return tool.execute("call", params, undefined, undefined, {} as never);
}

describe("Agency tool policy", () => {
  it("exports auditable least-privilege role sets", () => {
    expect(ROLE_TOOL_POLICY.planner).toEqual([
      "read", "grep", "find", "ls", "submit_plan", "request_human_input",
    ]);
    expect(ROLE_TOOL_POLICY.planner).not.toEqual(expect.arrayContaining(["edit", "write", "bash"]));
    expect(ROLE_TOOL_POLICY.executor).toEqual(expect.arrayContaining([
      "edit", "write", "bash", "request_human_input", "record_project_knowledge",
    ]));
    expect(POLICY_DISPLAY).toContain("not an OS sandbox");
    expect(POLICY_DISPLAY).toContain("exact one-shot action");
  });

  it("contains reads and directory tools inside repository", async () => {
    const { root, outside } = await fixture();
    const tools = createRoleFileTools({ root, role: "planner" });
    const read = tools.find(({ name }) => name === "read")!;
    const ls = tools.find(({ name }) => name === "ls")!;
    const grep = tools.find(({ name }) => name === "grep")!;
    const find = tools.find(({ name }) => name === "find")!;

    await expect(invoke(read, { path: "src/safe.ts" })).resolves.toBeDefined();
    const rootGrep = await invoke(grep, { path: ".", pattern: "export const" });
    expect(JSON.stringify(rootGrep)).toContain("src/safe.ts");
    expect(JSON.stringify(rootGrep)).not.toMatch(/\.git|\.devagency|secret/u);
    const rootFind = await invoke(find, { path: ".", pattern: "**/*" });
    expect(JSON.stringify(rootFind)).toContain("src/safe.ts");
    expect(JSON.stringify(rootFind)).not.toMatch(/\.git|\.devagency|outside|private/u);
    await expect(invoke(grep, { path: "src", pattern: "secret" })).resolves.toMatchObject({
      content: [{ text: "No matches found" }],
    });
    await link(join(outside, "secret.txt"), join(root, "outside-hardlink"));
    for (const path of [join(outside, "secret.txt"), "../secret.txt", "outside-link", "outside-hardlink", ".git/config", ".GIT/config", ".devagency/checkpoint.json", "private-alias"]) {
      await expect(invoke(read, { path }), path).rejects.toThrow("Agency policy");
    }
    await expect(invoke(grep, { path: ".", pattern: "outside-secret" })).rejects.toThrow("hard-linked");
    await expect(invoke(ls, { path: "outside-dir" })).rejects.toThrow("Agency policy");
    const listing = await invoke(ls, { path: "." });
    expect(JSON.stringify(listing)).not.toContain(".devagency");
    expect(JSON.stringify(listing)).not.toContain(".git");
    const executorRead = createRoleFileTools({ root, role: "executor" }).find(({ name }) => name === "read")!;
    await expect(invoke(executorRead, { path: ".git/config" })).rejects.toThrow("private");
  });

  it("contains executor mutation and consumes exact sensitive approval once", async () => {
    const { root } = await fixture();
    let approved = "write:package.json";
    const tools = createRoleFileTools({
      root,
      role: "executor",
      consumeApproval: (action) => {
        if (action !== approved) return false;
        approved = "";
        return true;
      },
    });
    const write = tools.find(({ name }) => name === "write")!;

    await expect(invoke(write, { path: "package.json", content: "{\"name\":\"safe\"}\n" })).rejects.toThrow("sha256:");
    approved = (await invoke(write, { path: "package.json", content: "{\"name\":\"safe\"}\n" }).catch((error: Error) => error.message)).match(/write:package\.json sha256:[a-f0-9]+/u)?.[0] ?? "";
    const before = await lstat(join(root, "package.json"));
    await expect(invoke(write, { path: "package.json", content: "{\"name\":\"safe\"}\n" })).resolves.toBeDefined();
    const after = await lstat(join(root, "package.json"));
    expect(after.ino).not.toBe(before.ino);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe("{\"name\":\"safe\"}\n");
    await expect(invoke(write, { path: "package.json", content: "{}\n" })).rejects.toThrow("one-shot approval");
    await expect(invoke(write, { path: ".git/config", content: "nope" })).rejects.toThrow("control paths");
    await expect(invoke(write, { path: ".GIT/config", content: "nope" })).rejects.toThrow("control paths");
    await expect(invoke(write, { path: "../escape", content: "nope" })).rejects.toThrow("traversal");
    await expect(invoke(write, { path: "outside-link", content: "nope" })).rejects.toThrow("non-symlink");
  });

  it("denies a fourth distinct mission path before mutation", async () => {
    const { root } = await fixture();
    const budget = new MissionMutationBudget();
    budget.reconcile(3, []);
    const write = createRoleFileTools({ root, role: "executor", mutationBudget: budget })
      .find(({ name }) => name === "write")!;
    for (const path of ["one.ts", "two.ts", "three.ts"]) {
      await expect(invoke(write, { path, content: path })).resolves.toBeDefined();
    }
    await expect(invoke(write, { path: "four.ts", content: "forbidden" })).rejects.toThrow(
      "mission mutation budget is limited to 3 distinct paths",
    );
    await expect(readFile(join(root, "four.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically reserves at most three parallel mission paths", async () => {
    const { root } = await fixture();
    const budget = new MissionMutationBudget();
    budget.reconcile(3, []);
    const write = createRoleFileTools({ root, role: "executor", mutationBudget: budget })
      .find(({ name }) => name === "write")!;
    const settled = await Promise.allSettled(["one", "two", "three", "four"].map((path) =>
      invoke(write, { path: `${path}.ts`, content: path })));
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(3);
    expect(settled.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await Promise.all(["one", "two", "three", "four"].map(async (path) =>
      readFile(join(root, `${path}.ts`), "utf8").then(() => true, () => false))))
      .filter(Boolean)).toHaveLength(3);
  });

  it("releases only a failed new mission reservation", async () => {
    const budget = new MissionMutationBudget();
    budget.reconcile(1, []);
    await expect(budget.run("failed.ts", async () => { throw new Error("delegate failed"); }))
      .rejects.toThrow("delegate failed");
    await expect(budget.run("replacement.ts", async () => "ok")).resolves.toBe("ok");
    await expect(budget.run("replacement.ts", async () => "same")).resolves.toBe("same");
    expect([...budget.paths]).toEqual(["replacement.ts"]);
  });

  it("allows local verification but blocks unsafe shell variants", () => {
    const allowed = [
      { command: "npm", args: ["run", "test"] },
      { command: "npm", args: ["run", "typecheck"] },
    ];
    expect(() => assertAllowedBash("npm run test", () => false, allowed)).not.toThrow();
    expect(() => assertAllowedBash("git status --short", () => false, allowed)).not.toThrow();
    for (const command of [
      "curl https://example.com", "env", "git add src", "git -c alias.x=push x", "npm publish",
      "aws sts get-caller-identity", "sudo npm test", "sh -c 'npm test'", "node -e 'x'",
      "echo $(printenv)", "cat src/a > /tmp/a", "./scripts/publish.sh", "rsync src user@host:/tmp",
      "cat .env", "cat outside-link", "cd .. && cat secret", "npx some-package", "npm exec some-package",
      "npm run arbitrary", "npm run test -- --runInBand", "true", "git -C .. status", "git --git-dir=.git status",
      "git diff --output=leak", "git show --textconv HEAD:file", "git status; curl x", "git status && git diff",
      "git show HEAD:.env",
      "(git status)", "{ git status; }", "FOO=bar npm run test", "npm run test*", "python3.12 -c pass",
      "xargs npm run test", "parallel npm run test", "open https://example.com", "ping example.com",
      "docker run alpine", "kubectl get pods", "ps e",
    ]) {
      expect(() => assertAllowedBash(command, () => false, allowed), command).toThrow("Agency policy");
    }
  });

  it("requires exact one-shot approval for consequential shell", () => {
    let approved = bashApprovalAction(["rm", "-rf", "build"]);
    const consume = (action: string) => {
      if (action !== approved) return false;
      approved = "";
      return true;
    };
    expect(() => assertAllowedBash("rm -rf other", consume)).toThrow("exact action");
    expect(() => assertAllowedBash("rm -rf build", consume)).not.toThrow();
    expect(() => assertAllowedBash("rm -rf build", consume)).toThrow("one-shot approval");

    approved = bashApprovalAction(["rm", "-rf", "build  dir"]);
    expect(() => assertAllowedBash("rm -rf 'build dir'", consume)).toThrow("exact action");
    expect(() => assertAllowedBash("rm -rf 'build  dir'", consume)).not.toThrow();
  });

  it("does not burn file approval on invalid or pre-aborted calls", async () => {
    const { root } = await fixture();
    const consume = vi.fn(() => true);
    const write = createRoleFileTools({ root, role: "executor", consumeApproval: consume }).find(({ name }) => name === "write")!;
    await expect(invoke(write, { path: "package.json", content: 42 })).rejects.toThrow("string content");
    expect(consume).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(write.execute("aborted", { path: "package.json", content: "{}" }, controller.signal, undefined, {} as never)).rejects.toMatchObject({ name: "AbortError" });
    expect(consume).not.toHaveBeenCalled();
  });

  it("hardens Git argv and scrubs Bash environment at delegate boundary", async () => {
    let delegatedCommand = "";
    const createBashTool = vi.fn((_cwd: string, factoryOptions?: Parameters<typeof defaultToolFactoryBoundary.createBashTool>[1]) => ({
      name: "bash",
      label: "bash",
      description: "test",
      parameters: { type: "object" } as never,
      async execute(_id: string, params: unknown) {
        delegatedCommand = (params as { command: string }).command;
        return { content: [], details: {} };
      },
      factoryOptions,
    } as never));
    const factories = { ...defaultToolFactoryBoundary, createBashTool };
    const approval = bashApprovalAction(["rm", "-rf", "build"]);
    const consumeApproval = vi.fn((action: string) => action === approval);
    const bash = createProtectedBashTool({ root: "/repo", factories, consumeApproval });
    await bash.execute("git", { command: "git diff -- src" }, undefined, undefined, {} as never);
    expect(delegatedCommand).toBe("git diff --no-ext-diff --no-textconv -- src");

    const factoryOptions = createBashTool.mock.calls[0]?.[1];
    const spawned = factoryOptions?.spawnHook?.({
      command: delegatedCommand,
      cwd: "/attacker",
      env: { PATH: "/bin", AWS_SECRET_ACCESS_KEY: "secret", GIT_DIR: "/tmp/evil", NODE_OPTIONS: "--require evil" },
    });
    expect(spawned?.cwd).toBe("/repo");
    expect(spawned?.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(spawned?.env).not.toHaveProperty("GIT_DIR");
    expect(spawned?.env).not.toHaveProperty("NODE_OPTIONS");
    expect(spawned?.env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0", GIT_CEILING_DIRECTORIES: "/repo",
      GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false",
    });

    for (const timeout of ["5", 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483.648]) {
      await expect(bash.execute("invalid-timeout", { command: "rm -rf build", timeout }, undefined, undefined, {} as never), String(timeout)).rejects.toThrow("timeout");
    }
    expect(consumeApproval).not.toHaveBeenCalled();
    await expect(bash.execute("approved", { command: "rm -rf build", timeout: 5 }, undefined, undefined, {} as never)).resolves.toBeDefined();
    expect(consumeApproval).toHaveBeenCalledOnce();
  });
});
