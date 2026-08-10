import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InfrastructureError } from "../../src/process/index.js";
import { SessionStore } from "../../src/session/index.js";

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agency-session-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("SessionStore", () => {
  it("creates and atomically loads a UUID-backed session", async () => {
    const projectRoot = await temporaryProject();
    const store = new SessionStore(projectRoot);

    const created = await store.loadOrCreate();
    const loaded = await store.loadOrCreate();

    expect(created.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(loaded).toEqual(created);
    expect(
      JSON.parse(
        await readFile(join(projectRoot, ".devagency", "session.json"), "utf8"),
      ),
    ).toEqual(created);
    expect(await readdir(join(projectRoot, ".devagency"))).toEqual([
      "session.json",
    ]);
  });

  it("retains only the most recent schema-bounded turns and run summaries", async () => {
    const projectRoot = await temporaryProject();
    const store = new SessionStore(projectRoot);

    for (let index = 0; index < 25; index += 1) {
      await store.recordUserTurn(`request ${index}`);
    }
    for (let index = 0; index < 13; index += 1) {
      await store.recordRunSummary({
        runId: `run-${index}`,
        status: index % 2 === 0 ? "completed" : "failed",
        objective: `objective ${index}`,
        summary: `result ${index}`,
      });
    }

    const session = await store.loadOrCreate();
    expect(session.recentTurns).toHaveLength(20);
    expect(session.recentTurns[0]?.content).toBe("request 5");
    expect(session.recentTurns.at(-1)?.content).toBe("request 24");
    expect(session.recentTurns.every(({ role }) => role === "user")).toBe(true);
    expect(session.runSummaries).toHaveLength(10);
    expect(session.runSummaries[0]?.runId).toBe("run-3");
    expect(session.runSummaries.at(-1)?.runId).toBe("run-12");
  });

  it("starts a fresh session without touching other project metadata", async () => {
    const projectRoot = await temporaryProject();
    const store = new SessionStore(projectRoot);
    const first = await store.recordUserTurn("first request");
    const registryPath = join(
      projectRoot,
      ".devagency",
      "incomplete-runs.json",
    );
    await writeFile(registryPath, '{"runs":[]}', "utf8");

    const fresh = await store.createNew();

    expect(fresh.sessionId).not.toBe(first.sessionId);
    expect(fresh.recentTurns).toEqual([]);
    expect(fresh.runSummaries).toEqual([]);
    expect(await readFile(registryPath, "utf8")).toBe('{"runs":[]}');
  });

  it("reports corrupt session metadata as a typed infrastructure failure", async () => {
    const projectRoot = await temporaryProject();
    const metadataDirectory = join(projectRoot, ".devagency");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(metadataDirectory);
    await writeFile(join(metadataDirectory, "session.json"), "not json", "utf8");

    const error = await new SessionStore(projectRoot)
      .loadOrCreate()
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(InfrastructureError);
    expect(error).toMatchObject({ code: "METADATA_INVALID" });
  });
});
