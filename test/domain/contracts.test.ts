import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AgencyEventSchema,
  CommandResultSchema,
  PlanSchema,
  RepoContextSchema,
  RunStateSchema,
  SessionContextSchema,
  VerificationResultSchema,
  type AgencyEvent,
  type Plan,
} from "../../src/domain/index.js";

describe("PlanSchema", () => {
  const planInput = {
    objective: "Add durable orchestration contracts",
    steps: [
      { id: "define-contracts", description: "Define schemas" },
      { id: "add-event-bus", description: "Add event bus" },
      { id: "verify", description: "Verify contracts" },
    ],
    verificationStrategy: ["Run focused tests", "Run static checks"],
  };

  it("applies collection defaults and survives JSON serialization", () => {
    const plan = PlanSchema.parse(planInput);
    const roundTrip = PlanSchema.parse(JSON.parse(JSON.stringify(plan)));

    expect(plan).toEqual({
      ...planInput,
      assumptions: [],
      likelyFiles: [],
    });
    expect(roundTrip).toEqual(plan);
    expectTypeOf(plan).toEqualTypeOf<Plan>();
  });

  it("requires at least one strict, identified step", () => {
    expect(() => PlanSchema.parse({ ...planInput, steps: [] })).toThrow();
    expect(() =>
      PlanSchema.parse({
        ...planInput,
        steps: [{ id: "step-1", description: "Do work", extra: true }],
      }),
    ).toThrow();
    expect(
      PlanSchema.parse({
        ...planInput,
        steps: Array.from({ length: 8 }, (_, index) => ({
          id: `step-${index + 1}`,
          description: `Step ${index + 1}`,
        })),
      }).steps,
    ).toHaveLength(8);
  });
});

describe("runtime state contracts", () => {
  it("normalizes repository metadata defaults", () => {
    expect(
      RepoContextSchema.parse({
        rootPath: "/workspace/agency",
        project: { name: "agency" },
      }),
    ).toEqual({
      rootPath: "/workspace/agency",
      currentBranch: null,
      defaultBranch: null,
      isDirty: false,
      project: {
        name: "agency",
        languages: [],
        scripts: {},
      },
    });
  });

  it("round-trips command and verification results", () => {
    const command = CommandResultSchema.parse({
      command: "npm test",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 12,
    });
    const verification = VerificationResultSchema.parse({
      status: "passed",
      summary: "Focused tests passed",
      commands: [command],
    });

    expect(command).toMatchObject({ args: [], signal: null, timedOut: false });
    expect(
      VerificationResultSchema.parse(JSON.parse(JSON.stringify(verification))),
    ).toEqual(verification);
  });

  it("applies bounded session and run-state defaults", () => {
    expect(
      RunStateSchema.parse({
        runId: "run-1",
        threadId: "thread-1",
        repoPath: "/workspace/agency",
        sessionId: "session-1",
        status: "planning",
        userIntent: "Build contracts",
      }),
    ).toEqual({
      runId: "run-1",
      threadId: "thread-1",
      repoPath: "/workspace/agency",
      sessionId: "session-1",
      status: "planning",
      userIntent: "Build contracts",
      attempt: 0,
      changedFiles: [],
      completedStepIds: [],
      currentStepId: null,
      failure: null,
      maxRepairAttempts: 2,
      plan: null,
      repoContext: null,
      summary: "",
      verification: null,
    });

    const state = RunStateSchema.parse({
      runId: "run-1",
      threadId: "thread-1",
      repoPath: "/workspace/agency",
      sessionId: "session-1",
      status: "executing",
      userIntent: "Build contracts",
    });
    expect(RunStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);

    expect(() =>
      RunStateSchema.parse({
        ...state,
        attempt: -1,
      }),
    ).toThrow();
    expect(() =>
      RunStateSchema.parse({
        ...state,
        maxRepairAttempts: 0,
      }),
    ).toThrow();

    expect(SessionContextSchema.parse({ sessionId: "session-1" })).toEqual({
      sessionId: "session-1",
      recentTurns: [],
      runSummaries: [],
    });

    expect(() =>
      SessionContextSchema.parse({
        sessionId: "session-1",
        recentTurns: Array.from({ length: 21 }, (_, index) => ({
          role: "user",
          content: `Turn ${index}`,
        })),
      }),
    ).toThrow();
  });
});

describe("AgencyEventSchema", () => {
  const events: AgencyEvent[] = [
    { type: "phase", phase: "preparing" },
    { type: "tool", tool: "read", detail: "package.json" },
    { type: "file_changed", path: "src/domain/contracts.ts" },
    { type: "command_started", command: "npm test" },
    {
      type: "command_finished",
      command: "npm test",
      exitCode: 0,
      durationMs: 50,
    },
    { type: "message", content: "Verification complete" },
    { type: "error", message: "Verification failed" },
  ];

  it("parses every normalized UI event variant", () => {
    for (const event of events) {
      expect(AgencyEventSchema.parse(event)).toEqual(event);
    }
  });

  it("rejects invalid phase and command measurements", () => {
    expect(() =>
      AgencyEventSchema.parse({ type: "phase", phase: "completed" }),
    ).toThrow();
    expect(() =>
      AgencyEventSchema.parse({
        type: "command_finished",
        command: "npm test",
        exitCode: 0.5,
        durationMs: -1,
      }),
    ).toThrow();
  });
});
