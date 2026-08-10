import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  InfrastructureError,
  captureGitBaseline,
  ensureAgencyMetadataIgnored,
  findGitRoot,
  getChangedFiles,
  inspectRepository,
  resolveGitExcludePath,
} from "../../src/repo/index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agency-repo-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function initializedRepository(): Promise<string> {
  const directory = await temporaryDirectory();
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.email", "test@example.com");
  await git(directory, "config", "user.name", "Agency Test");
  await writeFile(join(directory, "kept.txt"), "original\n");
  await writeFile(join(directory, "removed.txt"), "remove me\n");
  await writeFile(join(directory, "already-deleted.txt"), "gone before baseline\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial");
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("repository inspection", () => {
  it("adds the Agency rule to the local exclude exactly once", async () => {
    const root = await initializedRepository();
    const excludePath = await resolveGitExcludePath(root);
    const before = await readFile(excludePath, "utf8");

    await ensureAgencyMetadataIgnored(root);
    await ensureAgencyMetadataIgnored(root);

    const after = await readFile(excludePath, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.split(/\r?\n/u).filter((line) => line === ".devagency/"))
      .toHaveLength(1);
  });

  it("reports local exclude update failures as typed infrastructure errors", async () => {
    const root = await initializedRepository();
    const excludePath = await resolveGitExcludePath(root);
    await rm(excludePath);
    await mkdir(excludePath);

    await expect(ensureAgencyMetadataIgnored(root)).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "GIT_EXCLUDE_SETUP_FAILED",
    });
  });

  it("resolves and updates the Git exclude file from a linked worktree", async () => {
    const root = await initializedRepository();
    const worktree = `${root}-linked`;
    temporaryDirectories.push(worktree);
    await git(root, "worktree", "add", "-b", "linked", worktree);

    const excludePath = await resolveGitExcludePath(worktree);
    await ensureAgencyMetadataIgnored(worktree);

    expect(excludePath).not.toBe(join(worktree, ".git", "info", "exclude"));
    expect((await readFile(excludePath, "utf8")).split(/\r?\n/u))
      .toContain(".devagency/");
  });

  it("reports a typed infrastructure error outside Git", async () => {
    const directory = await temporaryDirectory();

    await expect(findGitRoot(directory)).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "NOT_GIT_REPOSITORY",
    });

    try {
      await findGitRoot(directory);
    } catch (error) {
      expect(error).toBeInstanceOf(InfrastructureError);
    }
  });

  it("inspects branch, dirty state, package metadata, and instructions", async () => {
    const root = await initializedRepository();
    await mkdir(join(root, "packages", "app"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture-app",
        version: "1.2.3",
        description: "Fixture",
        packageManager: "npm@11.0.0",
        scripts: { test: "vitest run" },
      }),
    );
    await writeFile(join(root, "tsconfig.json"), "{}\n");
    await writeFile(join(root, "AGENTS.md"), "Follow fixture rules.\n");

    const inspection = await inspectRepository(join(root, "packages", "app"));

    expect(inspection).toMatchObject({
      rootPath: await realpath(root),
      currentBranch: "main",
      isDirty: true,
      project: {
        name: "fixture-app",
        version: "1.2.3",
        description: "Fixture",
        packageManager: "npm@11.0.0",
        scripts: { test: "vitest run" },
      },
    });
    expect(inspection.project.languages).toContain("TypeScript");
    expect(inspection.instructionFiles).toEqual([
      join(await realpath(root), "AGENTS.md"),
    ]);
    expect(inspection.porcelain).toContain("?? AGENTS.md");
  });

  it("treats a missing package manifest as absent", async () => {
    const root = await initializedRepository();

    const inspection = await inspectRepository(root);

    expect(inspection.packageJsonPath).toBeNull();
    expect(inspection.project.languages).toEqual([]);
  });

  it("reports an existing invalid package manifest", async () => {
    const root = await initializedRepository();
    await writeFile(join(root, "package.json"), "not json", "utf8");

    await expect(inspectRepository(root)).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "PACKAGE_METADATA_INVALID",
    });
  });

  it("preserves lockfile package-manager precedence", async () => {
    const root = await initializedRepository();
    await Promise.all([
      writeFile(join(root, "package.json"), "{}", "utf8"),
      writeFile(join(root, "pnpm-lock.yaml"), "", "utf8"),
      writeFile(join(root, "yarn.lock"), "", "utf8"),
      writeFile(join(root, "bun.lock"), "", "utf8"),
      writeFile(join(root, "package-lock.json"), "", "utf8"),
    ]);

    const inspection = await inspectRepository(root);

    expect(inspection.project.packageManager).toBe("pnpm");
  });
});

describe("Git baselines", () => {
  it("captures the same index concurrently without taking an index lock", async () => {
    const root = await initializedRepository();
    const heldLock = join(root, ".git", "index.lock");
    await writeFile(heldLock, "held by another read-only observer\n");

    const baselines = await Promise.all(
      Array.from({ length: 8 }, async () => await captureGitBaseline(root)),
    );

    expect(new Set(baselines.map((baseline) => baseline.indexTree))).toHaveLength(1);
  });

  it("keeps clean unaffected files out of the sparse identity snapshot", async () => {
    const root = await initializedRepository();
    const baseline = await captureGitBaseline(root);

    expect(baseline.paths).not.toHaveProperty("kept.txt");
    await writeFile(join(root, "added.txt"), "new\n");
    await expect(getChangedFiles(baseline)).resolves.toEqual([
      { path: "added.txt", status: "added" },
    ]);
    expect(baseline.paths).not.toHaveProperty("removed.txt");
    expect(baseline).not.toHaveProperty("porcelain");
  });

  it("rejects index-only mutations after the baseline", async () => {
    const root = await initializedRepository();
    await writeFile(join(root, "kept.txt"), "staged before baseline\n");
    await git(root, "add", "kept.txt");
    const baseline = await captureGitBaseline(root);
    expect(baseline.paths["kept.txt"]?.statusCode).toBe("M ");

    await git(root, "reset", "--", "kept.txt");

    await expect(getChangedFiles(baseline)).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "GIT_BASELINE_VIOLATED",
    });
  });

  it("rejects commits created after the baseline even when the worktree is clean", async () => {
    const root = await initializedRepository();
    const baseline = await captureGitBaseline(root);
    await writeFile(join(root, "kept.txt"), "committed by the agent\n");
    await git(root, "add", "kept.txt");
    await git(root, "commit", "-m", "unexpected agent commit");

    await expect(getChangedFiles(baseline)).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "GIT_BASELINE_VIOLATED",
    });
  });

  it("excludes preexisting dirt and detects later changes to the same paths", async () => {
    const root = await initializedRepository();
    await writeFile(join(root, "kept.txt"), "dirty before baseline\n");
    await writeFile(join(root, "preexisting.txt"), "untracked before baseline\n");
    await rm(join(root, "already-deleted.txt"));
    const baseline = await captureGitBaseline(root);

    await expect(getChangedFiles(baseline)).resolves.toEqual([]);

    await writeFile(join(root, "kept.txt"), "changed again after baseline\n");
    await writeFile(join(root, "preexisting.txt"), "untracked changed after baseline\n");
    await writeFile(join(root, "already-deleted.txt"), "restored after baseline\n");
    await rm(join(root, "removed.txt"));
    await writeFile(join(root, "added.txt"), "new\n");

    await expect(getChangedFiles(baseline)).resolves.toEqual([
      { path: "added.txt", status: "added" },
      { path: "already-deleted.txt", status: "modified" },
      { path: "kept.txt", status: "modified" },
      { path: "preexisting.txt", status: "modified" },
      { path: "removed.txt", status: "deleted" },
    ]);
  });
});
