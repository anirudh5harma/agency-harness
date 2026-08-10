import { describe, expect, expectTypeOf, it } from "vitest";

import type { Plan, RepoContext } from "../../src/domain/index.js";
import {
  FakeCodingRuntime,
  type CodingRuntime,
  type CreatePlanInput,
  type ExecuteInput,
  type RepairInput,
} from "../../src/coding/index.js";

const repo: RepoContext = {
  rootPath: "/workspace/agency",
  currentBranch: "main",
  defaultBranch: "main",
  isDirty: false,
  project: {
    name: "agency",
    languages: ["TypeScript"],
    scripts: { test: "vitest run" },
  },
};

const plan: Plan = {
  objective: "Add a coding runtime",
  assumptions: [],
  steps: [{ id: "runtime", description: "Implement the runtime" }],
  likelyFiles: ["src/coding/runtime.ts"],
  verificationStrategy: ["Run focused tests"],
};

describe("CodingRuntime", () => {
  it("has stable create, execute, repair, abort, and disposal contracts", () => {
    expectTypeOf<CodingRuntime["createPlan"]>().parameter(0).toEqualTypeOf<CreatePlanInput>();
    expectTypeOf<CodingRuntime["execute"]>().parameter(0).toEqualTypeOf<ExecuteInput>();
    expectTypeOf<CodingRuntime["repair"]>().parameter(0).toEqualTypeOf<RepairInput>();
    expectTypeOf<CodingRuntime>().toHaveProperty("abort");
    expectTypeOf<CodingRuntime>().toHaveProperty("dispose");
  });
});

describe("FakeCodingRuntime", () => {
  it("returns queued deterministic results and records call inputs", async () => {
    const fake = new FakeCodingRuntime();
    const planResult = { plan, message: "Plan ready" };
    const executionResult = {
      message: "Implementation ready for verification",
      changedFiles: ["src/coding/runtime.ts"],
      sessionId: "executor-1",
    };
    const repairResult = {
      message: "Repair ready for verification",
      changedFiles: ["src/coding/runtime.ts"],
      sessionId: "executor-1",
    };
    fake.enqueuePlanResult(planResult);
    fake.enqueueExecuteResult(executionResult);
    fake.enqueueRepairResult(repairResult);

    const createInput: CreatePlanInput = { intent: "Build it", repo };
    const executeInput: ExecuteInput = { intent: "Build it", repo, plan };
    const repairInput: RepairInput = {
      ...executeInput,
      attempt: 1,
      failure: {
        stage: "verifying",
        message: "Tests failed",
        recoverable: true,
      },
    };

    await expect(fake.createPlan(createInput)).resolves.toEqual(planResult);
    await expect(fake.execute(executeInput)).resolves.toEqual(executionResult);
    await expect(fake.repair(repairInput)).resolves.toEqual(repairResult);
    expect(fake.calls).toEqual({
      createPlan: [createInput],
      execute: [executeInput],
      repair: [repairInput],
    });
  });

  it("queues typed failures and exposes abort/dispose calls", async () => {
    const fake = new FakeCodingRuntime();
    const failure = new Error("provider unavailable");
    fake.enqueuePlanResult(failure);

    await expect(fake.createPlan({ intent: "Build it", repo })).rejects.toBe(failure);
    await fake.abort();
    await fake.dispose();

    expect(fake.abortCalls).toBe(1);
    expect(fake.isDisposed).toBe(true);
  });
});
