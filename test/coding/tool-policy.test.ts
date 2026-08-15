import { link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
const exec = promisify(execFile);

async function fixture(): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "agency-policy-root-"));
  const outside = await mkdtemp(join(tmpdir(), "agency-policy-outside-"));
  temporaryDirectories.push(root, outside);
  await mkdir(join(root, "src"));
  await mkdir(join(root, ".devagency"));
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["config", "user.name", "Agency Test"], { cwd: root });
  await exec("git", ["config", "user.email", "agency@example.test"], { cwd: root });
  await writeFile(join(root, "src", "safe.ts"), "export const safe = true;\n");
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, ".devagency", "checkpoint.json"), "private\n");
  await writeFile(join(root, ".env.local"), "API_TOKEN=secret\n");
  await mkdir(join(root, ".docker"));
  await writeFile(join(root, ".docker", "config.json"), "{\"auths\":{\"registry\":\"secret\"}}\n");
  await writeFile(join(root, "client_secret_test.json"), "{\"secret\":true}\n");
  await writeFile(join(root, "credentials.json"), "{\"token\":\"secret\"}\n");
  await mkdir(join(root, "keys"));
  await writeFile(join(root, "keys", "service.pem"), "secret-key\n");
  await writeFile(join(outside, "secret.txt"), "outside-secret\n");
  await symlink(join(outside, "secret.txt"), join(root, "outside-link"));
  await symlink(outside, join(root, "outside-dir"));
  await symlink(outside, join(root, "src", "nested-outside"));
  await symlink(join(root, ".git", "config"), join(root, "private-alias"));
  await symlink(join(root, ".env.local"), join(root, "environment-alias"));
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
    const rootGrep = await invoke(grep, { path: ".", pattern: "export const", literal: true });
    expect(JSON.stringify(rootGrep)).toContain("src/safe.ts");
    expect(JSON.stringify(rootGrep)).not.toMatch(/\.git|\.devagency|secret/u);
    const rootFind = await invoke(find, { path: ".", pattern: "**/*" });
    expect(JSON.stringify(rootFind)).toContain("src/safe.ts");
    expect(JSON.stringify(rootFind)).not.toMatch(/\.git|\.devagency|outside|private/u);
    expect(JSON.stringify(rootFind)).not.toMatch(/\.env|credentials|service\.pem|environment-alias/u);
    expect(JSON.stringify(rootGrep)).not.toContain("API_TOKEN");
    await expect(invoke(grep, { path: "src", pattern: "secret", literal: true })).resolves.toMatchObject({
      content: [{ text: "No matches found" }],
    });
    await link(join(outside, "secret.txt"), join(root, "outside-hardlink"));
    for (const path of [join(outside, "secret.txt"), "../secret.txt", "outside-link", "outside-hardlink", ".git/config", ".GIT/config", ".devagency/checkpoint.json", "private-alias"]) {
      await expect(invoke(read, { path }), path).rejects.toThrow("Agency policy");
    }
    await expect(invoke(grep, { path: ".", pattern: "outside-secret", literal: true })).rejects.toThrow("hard-linked");
    await expect(invoke(ls, { path: "outside-dir" })).rejects.toThrow("Agency policy");
    const listing = await invoke(ls, { path: "." });
    expect(JSON.stringify(listing)).not.toContain(".devagency");
    expect(JSON.stringify(listing)).not.toContain(".git");
    expect(JSON.stringify(listing)).not.toContain(".env.local");
    const executorRead = createRoleFileTools({ root, role: "executor" }).find(({ name }) => name === "read")!;
    await expect(invoke(executorRead, { path: ".git/config" })).rejects.toThrow("private");
    for (const credential of [".env.local", ".docker/config.json", "client_secret_test.json", "credentials.json", "keys/service.pem", "environment-alias"]) {
      await expect(invoke(read, { path: credential }), credential).rejects.toThrow("credential-like");
      await expect(invoke(executorRead, { path: credential }), credential).rejects.toThrow("credential-like");
    }
    const consumeApproval = vi.fn(() => true);
    const credentialWrite = createRoleFileTools({ root, role: "executor", consumeApproval })
      .find(({ name }) => name === "write")!;
    await expect(invoke(credentialWrite, { path: ".env.local", content: "API_TOKEN=replaced\n" }))
      .rejects.toThrow("credential-like paths cannot be changed");
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  it("bounds search traversal and observes cancellation", async () => {
    const { root } = await fixture();
    let directory = root;
    for (let depth = 0; depth < 34; depth += 1) {
      directory = join(directory, `depth-${depth}`);
      await mkdir(directory);
    }
    await writeFile(join(directory, "deep.ts"), "needle\n");
    const grep = createRoleFileTools({ root, role: "planner" }).find(({ name }) => name === "grep")!;
    await expect(invoke(grep, { path: ".", pattern: "needle", literal: true })).rejects.toThrow("depth limit");

    const controller = new AbortController();
    controller.abort();
    await expect(grep.execute("aborted", { path: ".", pattern: "needle", literal: true }, controller.signal, undefined, {} as never))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("honors Git ignore rules during search", async () => {
    const { root } = await fixture();
    await writeFile(join(root, ".gitignore"), "custom-generated/\n");
    await mkdir(join(root, "custom-generated"));
    await writeFile(join(root, "custom-generated", "ignored.txt"), "ignored-secret-marker\n");
    const grep = createRoleFileTools({ root, role: "planner" }).find(({ name }) => name === "grep")!;
    const result = await invoke(grep, { path: ".", pattern: "ignored-secret-marker", literal: true });
    expect(JSON.stringify(result)).not.toContain("ignored-secret-marker");
  });

  it("accepts only literal grep patterns and bounds direct reads", async () => {
    const { root } = await fixture();
    const tools = createRoleFileTools({ root, role: "planner" });
    const grep = tools.find(({ name }) => name === "grep")!;
    const read = tools.find(({ name }) => name === "read")!;
    await expect(invoke(grep, { path: ".", pattern: "(a+)+$" })).rejects.toThrow("literal: true");
    await expect(invoke(grep, { path: ".", pattern: "export const", literal: false })).rejects.toThrow("literal: true");
    await expect(invoke(grep, { path: ".", pattern: "export const", literal: true })).resolves.toBeDefined();
    await writeFile(join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 97));
    await expect(invoke(read, { path: "large.txt" })).rejects.toThrow("1048576 byte limit");
  });

  it("excludes conservative credential names and generated search trees", async () => {
    const { root } = await fixture();
    const credentialPaths = [
      ".npmrc", ".yarnrc.yml", ".pypirc", ".netrc", ".git-credentials", "id_rsa", "id_ed25519",
      "auth.json", "kubeconfig", "prod.service-account.json", "secret.tfvars", "secret.tfvars.json",
    ];
    for (const path of credentialPaths) await writeFile(join(root, path), "needle-secret\n");
    await writeFile(join(root, "id_rsa.pub"), "public material\n");
    for (const directory of ["node_modules", "dist", "build", "coverage", ".next", "vendor", "target"]) {
      await mkdir(join(root, directory));
      await writeFile(join(root, directory, "generated.txt"), "needle-generated\n");
    }
    const tools = createRoleFileTools({ root, role: "planner" });
    const read = tools.find(({ name }) => name === "read")!;
    const grep = tools.find(({ name }) => name === "grep")!;
    const find = tools.find(({ name }) => name === "find")!;
    for (const path of credentialPaths) await expect(invoke(read, { path }), path).rejects.toThrow("credential-like");
    await expect(invoke(read, { path: "id_rsa.pub" })).resolves.toBeDefined();
    const grepResult = await invoke(grep, { path: ".", pattern: "needle-", literal: true });
    const findResult = await invoke(find, { path: ".", pattern: "**/*" });
    expect(JSON.stringify(grepResult)).not.toMatch(/secret|generated/u);
    expect(JSON.stringify(findResult)).not.toMatch(/\.npmrc|\.tfvars|node_modules|dist\/|build\/|coverage|\.next|vendor|target/u);
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

  it("never permits dependency, lockfile, or migration mutations and preserves approval", async () => {
    const { root } = await fixture();
    await mkdir(join(root, "prisma", "migrations"), { recursive: true });
    await writeFile(join(root, "package-lock.json"), "{}\n");
    await writeFile(join(root, "prisma", "migrations", "001.sql"), "select 1;\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "safe", dependencies: { zod: "1.0.0" } }, null, 2));

    const consumeApproval = vi.fn(() => true);
    const tools = createRoleFileTools({ root, role: "executor", consumeApproval });
    const edit = tools.find(({ name }) => name === "edit")!;
    const write = tools.find(({ name }) => name === "write")!;
    const blocked = [
      invoke(write, { path: "package-lock.json", content: "{\"lockfileVersion\":3}\n" }),
      invoke(edit, { path: "package-lock.json", edits: [{ oldText: "{}", newText: "{\"lockfileVersion\":3}" }] }),
      invoke(write, { path: "prisma/migrations/001.sql", content: "drop table users;\n" }),
      invoke(edit, { path: "prisma/migrations/001.sql", edits: [{ oldText: "select 1", newText: "drop table users" }] }),
      invoke(write, { path: "package.json", content: JSON.stringify({ name: "safe", dependencies: { zod: "2.0.0" } }) }),
      invoke(edit, { path: "package.json", edits: [{ oldText: '"zod": "1.0.0"', newText: '"zod": "2.0.0"' }] }),
    ];
    for (const result of blocked) await expect(result).rejects.toThrow("Agency policy blocks this operation");
    expect(consumeApproval).not.toHaveBeenCalled();
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
      "git diff", "git diff -- .", "git diff -- '*.ts'", "git show -- src/",
      "(git status)", "{ git status; }", "FOO=bar npm run test", "npm run test*", "python3.12 -c pass",
      "xargs npm run test", "parallel npm run test", "open https://example.com", "ping example.com",
      "docker run alpine", "kubectl get pods", "ps e",
    ]) {
      expect(() => assertAllowedBash(command, () => false, allowed), command).toThrow("Agency policy");
    }
  });

  it("requires exact one-shot approval for consequential shell", () => {
    let approved = bashApprovalAction(["rm", "-rf", "build"]);
    expect(approved).toMatch(/^bash:rm argv:rm -rf build sha256:[a-f0-9]{64}$/u);
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

  it("rejects approved rm targets through symlink parents and private aliases", async () => {
    const { root } = await fixture();
    await writeFile(join(root, ".devagency", "private.txt"), "private\n");
    await symlink(join(root, ".devagency"), join(root, "metadata-alias"));
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const factories = {
      ...defaultToolFactoryBoundary,
      createBashTool: vi.fn(() => ({
        name: "bash", label: "bash", description: "test",
        parameters: { type: "object" } as never,
        execute,
      } as never)),
    };

    for (const target of ["outside-dir/secret.txt", "src/nested-outside/secret.txt", "metadata-alias/private.txt"]) {
      const action = bashApprovalAction(["rm", "-rf", target]);
      const bash = createProtectedBashTool({ root, factories, consumeApproval: (candidate) => candidate === action });
      await expect(
        bash.execute("approved-rm", { command: `rm -rf ${target}` }, undefined, undefined, {} as never),
        target,
      ).rejects.toThrow("Agency policy");
    }
    expect(execute).not.toHaveBeenCalled();
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
    const { root } = await fixture();
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
    const bash = createProtectedBashTool({ root, factories, consumeApproval });
    await bash.execute("git", { command: "git diff -- src/safe.ts" }, undefined, undefined, {} as never);
    expect(delegatedCommand).toBe("git diff --no-ext-diff --no-textconv -- src/safe.ts");
    await expect(bash.execute("git-directory", { command: "git diff -- src" }, undefined, undefined, {} as never))
      .rejects.toThrow("regular file");
    await expect(bash.execute("git-credential", { command: "git show -- .npmrc" }, undefined, undefined, {} as never))
      .rejects.toThrow("credential-like");

    const factoryOptions = createBashTool.mock.calls[0]?.[1];
    const spawned = factoryOptions?.spawnHook?.({
      command: delegatedCommand,
      cwd: "/attacker",
      env: { PATH: "/bin", AWS_SECRET_ACCESS_KEY: "secret", GIT_DIR: "/tmp/evil", NODE_OPTIONS: "--require evil" },
    });
    expect(spawned?.cwd).toBe(root);
    expect(spawned?.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(spawned?.env).not.toHaveProperty("GIT_DIR");
    expect(spawned?.env).not.toHaveProperty("NODE_OPTIONS");
    expect(spawned?.env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0", GIT_CEILING_DIRECTORIES: root,
      GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false",
    });

    for (const timeout of ["5", 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483.648]) {
      await expect(bash.execute("invalid-timeout", { command: "rm -rf build", timeout }, undefined, undefined, {} as never), String(timeout)).rejects.toThrow("timeout");
    }
    expect(consumeApproval).not.toHaveBeenCalled();
    await mkdir(join(root, "build"));
    await writeFile(join(root, "build", "output.js"), "generated\n");
    await expect(bash.execute("approved", { command: "rm -rf build", timeout: 5 }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { agencyMutationPaths: ["build/output.js"] },
    });
    expect(consumeApproval).toHaveBeenCalledOnce();
  });
});
