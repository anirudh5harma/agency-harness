import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EvaluationStore,
  aggregateEvaluations,
  type RunEvaluation,
} from "../../src/evaluations/index.js";

const directories: string[] = [];

function evaluation(runId: string, overrides: Partial<RunEvaluation> = {}): RunEvaluation {
  return {
    schemaVersion: 1,
    runId,
    status: "completed",
    success: true,
    durationMs: 100,
    repairAttempts: 0,
    toolCalls: 2,
    modelCalls: { planner: 1, execute: 1, repair: 0, total: 2 },
    changedFileCount: 1,
    verification: { status: "passed", commandCount: 1, durationsMs: [20] },
    humanDecisionCount: 0,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("EvaluationStore", () => {
  it("writes strict redacted atomic per-run JSON and reads newest bounded records", async () => {
    const root = await mkdtemp(join(tmpdir(), "agency-evals-"));
    directories.push(root);
    const store = new EvaluationStore(root);
    await store.write(evaluation("run-1", { mission: "tests" }));
    const content = await readFile(join(root, ".devagency", "evaluations", "run-1.json"), "utf8");
    expect(JSON.parse(content)).toEqual(evaluation("run-1", { mission: "tests" }));
    expect(content).not.toContain("secret-value");
    expect(content).not.toContain("changedFiles");
    expect(content).not.toMatch(/"(?:prompt|intent|toolArgs|tokens?|cost)"\s*:/iu);
    expect(await readdir(join(root, ".devagency", "evaluations"))).toEqual(["run-1.json"]);
    expect((await store.listRecent(100)).evaluations).toEqual([evaluation("run-1", { mission: "tests" })]);
  });

  it("skips corrupt records and clamps reads to one hundred", async () => {
    const root = await mkdtemp(join(tmpdir(), "agency-evals-"));
    directories.push(root);
    const store = new EvaluationStore(root);
    for (let index = 0; index < 105; index += 1) await store.write(evaluation(`run-${String(index).padStart(3, "0")}`));
    const directory = join(root, ".devagency", "evaluations");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "corrupt.json"), "{not json");
    const result = await store.listRecent(500);
    expect(result.evaluations).toHaveLength(100);
    expect(result.corruptCount).toBe(1);
  });

  it("rejects unbounded or internally inconsistent records", async () => {
    const root = await mkdtemp(join(tmpdir(), "agency-evals-"));
    directories.push(root);
    const store = new EvaluationStore(root);
    await expect(store.write({
      ...evaluation("too-many"),
      changedFileCount: 2_001,
    })).rejects.toThrow();
  });

  it("rejects symlink containment and treats symlink or oversized JSON as corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "agency-evals-"));
    const outside = await mkdtemp(join(tmpdir(), "agency-evals-outside-"));
    directories.push(root, outside);
    await symlink(outside, join(root, ".devagency"));
    await expect(new EvaluationStore(root).write(evaluation("blocked"))).rejects.toThrow("must not be symlinks");
    await rm(join(root, ".devagency"));

    const store = new EvaluationStore(root);
    await store.write(evaluation("valid"));
    const directory = join(root, ".devagency", "evaluations");
    await symlink(join(directory, "valid.json"), join(directory, "linked.json"));
    await writeFile(join(directory, "oversized.json"), "x".repeat(70 * 1024));
    const result = await store.listRecent();
    expect(result.evaluations).toEqual([evaluation("valid")]);
    expect(result.corruptCount).toBe(2);
  });

  it("retains a bounded owned history and stays readable with excessive unrelated entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "agency-evals-"));
    directories.push(root);
    const store = new EvaluationStore(root);
    await store.write(evaluation("seed"));
    const directory = join(root, ".devagency", "evaluations");
    await rm(join(directory, "seed.json"));
    for (let offset = 0; offset < 1_000; offset += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, batchIndex) => {
        const index = offset + batchIndex;
        const record = evaluation(`run-${String(index).padStart(4, "0")}`);
        return writeFile(join(directory, `${record.runId}.json`), JSON.stringify(record));
      }));
    }
    await writeFile(join(directory, "unknown.json"), "{not agency metadata");
    await symlink("unknown.json", join(directory, "linked.json"));
    await store.write(evaluation("run-new"));
    const owned = (await readdir(directory)).filter((name) => /^run-(?:\d|new)/u.test(name));
    expect(owned).toHaveLength(1_000);
    expect(await readFile(join(directory, "unknown.json"), "utf8")).toBe("{not agency metadata");
    expect(await readlink(join(directory, "linked.json"))).toBe("unknown.json");

    for (let index = 0; index < 1_000; index += 1) {
      await writeFile(join(directory, `noise-${index}`), "");
    }
    const result = await store.listRecent(100);
    expect(result.evaluations).toHaveLength(100);
    expect(result.corruptCount).toBe(2);
  });
});

it("aggregates exact recent evaluation metrics", () => {
  expect(aggregateEvaluations([
    evaluation("one"),
    evaluation("two", {
      status: "failed", success: false, durationMs: 300, repairAttempts: 2,
      toolCalls: 4, modelCalls: { planner: 1, execute: 1, repair: 2, total: 4 },
      changedFileCount: 3,
      verification: { status: "failed", commandCount: 2, durationsMs: [10, 30] },
    }),
  ])).toEqual({
    runs: 2,
    successRate: 0.5,
    averageDurationMs: 200,
    averageRepairAttempts: 1,
    averageToolCalls: 3,
    averageModelCalls: 3,
    averageChangedFiles: 2,
    verificationPassRate: 0.5,
  });
});
