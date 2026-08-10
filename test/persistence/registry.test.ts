import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  IncompleteRunRegistry,
  discoverIncompleteRuns,
} from "../../src/persistence/index.js";
import { InfrastructureError } from "../../src/process/index.js";

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agency-registry-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("IncompleteRunRegistry", () => {
  const entry = {
    runId: "run-1",
    threadId: "thread-1",
    sessionId: "session-1",
    userIntent: "Build the requested feature",
    status: "executing" as const,
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:01:00.000Z",
  };

  it("round-trips only bounded recovery discovery fields atomically", async () => {
    const projectRoot = await temporaryProject();
    const registry = new IncompleteRunRegistry(projectRoot);

    await registry.upsert(entry);

    expect(await registry.list()).toEqual([entry]);
    expect(await discoverIncompleteRuns(projectRoot)).toEqual([entry]);
    expect(await readdir(join(projectRoot, ".devagency"))).toEqual([
      "incomplete-runs.json",
    ]);
    await expect(
      registry.upsert({ ...entry, secret: "do not persist" } as never),
    ).rejects.toMatchObject({ code: "METADATA_INVALID" });
  });

  it.each(["preparing", "planning", "verifying", "repairing"] as const)(
    "keeps %s runs discoverable",
    async (status) => {
      const projectRoot = await temporaryProject();
      const registry = new IncompleteRunRegistry(projectRoot);
      await registry.upsert({ ...entry, status });

      expect(await registry.list()).toEqual([{ ...entry, status }]);
    },
  );

  it.each(["completed", "failed", "cancelled"] as const)(
    "removes a run when its status becomes %s",
    async (status) => {
      const projectRoot = await temporaryProject();
      const registry = new IncompleteRunRegistry(projectRoot);
      await registry.upsert(entry);

      await registry.updateStatus(
        entry.runId,
        status,
        "2026-08-10T10:02:00.000Z",
      );

      expect(await registry.list()).toEqual([]);
    },
  );

  it("updates an incomplete status without changing discovery identity", async () => {
    const projectRoot = await temporaryProject();
    const registry = new IncompleteRunRegistry(projectRoot);
    await registry.upsert(entry);

    await registry.updateStatus(
      entry.runId,
      "verifying",
      "2026-08-10T10:02:00.000Z",
    );

    expect(await registry.list()).toEqual([
      {
        ...entry,
        status: "verifying",
        updatedAt: "2026-08-10T10:02:00.000Z",
      },
    ]);
  });

  it("turns corrupt recovery metadata into a typed safe-discovery failure", async () => {
    const projectRoot = await temporaryProject();
    const metadataDirectory = join(projectRoot, ".devagency");
    await mkdir(metadataDirectory);
    await writeFile(
      join(metadataDirectory, "incomplete-runs.json"),
      JSON.stringify({ runs: [{ ...entry, userIntent: "" }] }),
      "utf8",
    );

    const error = await discoverIncompleteRuns(projectRoot).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(InfrastructureError);
    expect(error).toMatchObject({ code: "METADATA_INVALID" });
  });
});
