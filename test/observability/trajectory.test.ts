import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("rejects run identifiers that could escape the runs directory", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, ".devagency"));
    const writer = new JsonlTrajectoryWriter(root);

    expect(() => writer.pathFor("../outside")).toThrow();
  });
});
