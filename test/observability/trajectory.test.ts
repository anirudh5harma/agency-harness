import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonlTrajectoryWriter,
  TrajectoryEventSchema,
} from "../../src/observability/index.js";

const directories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agency-trajectory-"));
  directories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("JSONL trajectory writer", () => {
  const event = {
    timestamp: "2026-08-10T10:00:00.000Z",
    runId: "run-1",
    sessionId: "session-1",
    event: "execution_completed" as const,
    durationMs: 42,
    metadata: { changedFileCount: 2 },
  };

  it("round-trips strict allowlisted events without accepting secret fields", async () => {
    const root = await temporaryRoot();
    const writer = new JsonlTrajectoryWriter(root);

    await writer.append(event);
    await expect(
      writer.append({ ...event, prompt: "token=secret" } as never),
    ).rejects.toMatchObject({ code: "TRAJECTORY_WRITE_FAILED" });

    const contents = await readFile(writer.pathFor(event.runId), "utf8");
    const records = contents.trim().split("\n").map((line) =>
      TrajectoryEventSchema.parse(JSON.parse(line) as unknown),
    );
    expect(records).toEqual([event]);
    expect(contents).not.toContain("secret");
    expect(contents).not.toContain("prompt");
    await expect(writer.append({
      ...event,
      metadata: { requestId: "request-1", decisionKind: "clarification", question: "secret question" },
    } as never)).rejects.toMatchObject({ code: "TRAJECTORY_WRITE_FAILED" });
  });

  it("returns a typed infrastructure error when the JSONL append fails", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, ".devagency"), "not a directory");
    const writer = new JsonlTrajectoryWriter(root);

    await expect(writer.append(event)).rejects.toMatchObject({
      name: "InfrastructureError",
      code: "TRAJECTORY_WRITE_FAILED",
    });
  });

  it("shares directory initialization across concurrent appends", async () => {
    const root = await temporaryRoot();
    const writer = new JsonlTrajectoryWriter(root);

    await Promise.all([
      writer.append(event),
      writer.append({ ...event, event: "verification_started" }),
    ]);

    const contents = await readFile(writer.pathFor(event.runId), "utf8");
    expect(contents.trim().split("\n")).toHaveLength(2);
  });

  it("rejects run identifiers that could escape the runs directory", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, ".devagency"));
    const writer = new JsonlTrajectoryWriter(root);

    expect(() => writer.pathFor("../outside")).toThrow();
  });

  it("rejects symlinked metadata directories and creates private files", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, ".devagency"));
    await expect(new JsonlTrajectoryWriter(root).append(event)).rejects.toMatchObject({
      code: "TRAJECTORY_WRITE_FAILED",
    });

    await rm(join(root, ".devagency"));
    await chmod(root, 0o755);
    const writer = new JsonlTrajectoryWriter(root);
    await writer.append(event);
    expect((await lstat(join(root, ".devagency"))).mode & 0o777).toBe(0o700);
    expect((await lstat(writer.runsPath)).mode & 0o777).toBe(0o700);
    expect((await lstat(writer.pathFor(event.runId))).mode & 0o777).toBe(0o600);
  });

  it("revalidates the runs directory before every append", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const writer = new JsonlTrajectoryWriter(root);
    await writer.append(event);
    await rm(writer.runsPath, { recursive: true });
    await symlink(outside, writer.runsPath);

    await expect(writer.append({ ...event, event: "verification_started" })).rejects.toMatchObject({
      code: "TRAJECTORY_WRITE_FAILED",
    });
    await expect(readFile(join(outside, `${event.runId}.jsonl`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
