import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { withPrivateMetadataFileLock } from "../../src/persistence/metadata-root.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agency-metadata-lock-"));
  temporaryDirectories.push(path);
  await mkdir(join(path, ".devagency"), { mode: 0o700 });
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("private metadata file leases", () => {
  it("reclaims a lease whose child-process owner crashed", async () => {
    const projectRoot = await temporaryProject();
    const path = join(projectRoot, ".devagency", "state.db");
    const lockPath = `${path}.lock`;
    const script = [
      'const fs = require("node:fs");',
      "fs.writeFileSync(process.argv[1], JSON.stringify({",
      '  pid: process.pid, token: "crashed-child", createdAt: Date.now(),',
      '  processStartId: "crashed-child-start"',
      "}));",
    ].join("\n");
    await execFileAsync(process.execPath, ["--eval", script, lockPath]);

    let entered = false;
    await withPrivateMetadataFileLock(projectRoot, path, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an unchanged lease from a prior process that reused this pid", async () => {
    const projectRoot = await temporaryProject();
    const path = join(projectRoot, ".devagency", "state.db");
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      token: "prior-process",
      createdAt: 0,
      processStartId: "prior-process-start",
    }));

    await expect(withPrivateMetadataFileLock(projectRoot, path, async () => "acquired"))
      .resolves.toBe("acquired");
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a live successor that replaces the owned lease before release", async () => {
    const projectRoot = await temporaryProject();
    const path = join(projectRoot, ".devagency", "state.db");
    const lockPath = `${path}.lock`;
    const displacedOwnerPath = `${lockPath}.displaced-owner`;
    const successor = JSON.stringify({
      pid: process.pid,
      token: "live-successor",
      createdAt: Date.now(),
      processStartId: "live-successor-start",
    });

    await withPrivateMetadataFileLock(projectRoot, path, async () => {
      await rename(lockPath, displacedOwnerPath);
      await writeFile(lockPath, successor, { mode: 0o600 });
    });

    expect(await readFile(lockPath, "utf8")).toBe(successor);
  });
});
