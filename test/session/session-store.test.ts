import { chmod, mkdtemp, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
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
    expect((await stat(join(projectRoot, ".devagency"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(projectRoot, ".devagency", "session.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects a linked metadata root and hardens legacy permissions", async () => {
    const linkedProject = await temporaryProject();
    const outside = await temporaryProject();
    await symlink(outside, join(linkedProject, ".devagency"));
    await expect(new SessionStore(linkedProject).loadOrCreate()).rejects.toMatchObject({
      code: "METADATA_READ_FAILED",
    });

    const legacyProject = await temporaryProject();
    const metadata = join(legacyProject, ".devagency");
    await mkdir(metadata, { mode: 0o755 });
    await writeFile(join(metadata, "session.json"), JSON.stringify({
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
      recentTurns: [], runSummaries: [], olderSummary: "", compactionCount: 0, lastCompactedAt: null,
    }), { mode: 0o644 });
    await chmod(metadata, 0o755);
    await chmod(join(metadata, "session.json"), 0o644);
    await new SessionStore(legacyProject).loadOrCreate();
    expect((await stat(metadata)).mode & 0o777).toBe(0o700);
    expect((await stat(join(metadata, "session.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps metadata scoped to an explicit project root beneath a .devagency-named parent", async () => {
    const container = await temporaryProject();
    const projectRoot = join(container, ".devagency", "nested-project");
    await mkdir(projectRoot, { recursive: true });
    const store = new SessionStore(projectRoot);

    const session = await store.loadOrCreate();

    expect(session.sessionId).toBeTruthy();
    expect((await stat(join(projectRoot, ".devagency"))).mode & 0o777).toBe(0o700);
    await expect(readFile(join(container, ".devagency", "session.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
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
    expect(session.olderSummary).toContain("[turn:user] request 0");
    expect(session.olderSummary).toContain("[run:completed] objective 0");
    expect(session.compactionCount).toBeGreaterThan(0);
  });

  it("loads Phase 1 JSON compatibly and explicitly compacts with redaction and counts", async () => {
    const projectRoot = await temporaryProject();
    const metadataDirectory = join(projectRoot, ".devagency");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(metadataDirectory);
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    await writeFile(join(metadataDirectory, "session.json"), JSON.stringify({
      sessionId,
      recentTurns: Array.from({ length: 10 }, (_, index) => ({ role: "user", content: index === 0 ? "token=secret-value" : `turn ${index}` })),
      runSummaries: Array.from({ length: 6 }, (_, index) => ({ runId: `r${index}`, status: "completed", objective: `o${index}`, summary: `s${index}` })),
    }));
    const store = new SessionStore(projectRoot);
    const loaded = await store.loadOrCreate();
    expect(loaded).toMatchObject({ olderSummary: "", compactionCount: 0, lastCompactedAt: null });
    const result = await store.compact();
    expect(result).toMatchObject({ beforeTurns: 10, afterTurns: 6, beforeRunSummaries: 6, afterRunSummaries: 4 });
    expect(result.session.olderSummary).not.toContain("secret-value");
    expect(result.session.olderSummary).toContain("[REDACTED]");
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
