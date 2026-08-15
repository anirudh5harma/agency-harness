import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AgencyEventSchema,
  CommandResultSchema,
  FailureContextSchema,
  HumanDecisionRequestSchema,
  HumanDecisionResponseSchema,
  PlanSchema,
  projectKnowledgeKey,
  ProjectKnowledgeEntrySchema,
  redactSecrets,
  recoverHumanDecisionRequest,
  renderProjectKnowledge,
  RepoContextSchema,
  SessionContextSchema,
  VerificationResultSchema,
  type AgencyEvent,
  type Plan,
} from "../../src/domain/index.js";

describe("project knowledge contracts", () => {
  it("rejects carriage returns and line feeds in a single entry", () => {
    for (const text of ["one\ntwo", "one\rtwo", "one\r\ntwo"]) {
      expect(() => ProjectKnowledgeEntrySchema.parse({ category: "learning", text })).toThrow();
    }
  });

  it("renders and keys validated entries from the entries source of truth", () => {
    const entries = [
      { category: "architecture" as const, text: "The graph owns verification." },
      { category: "decision" as const, text: "Keep checkpoints local." },
    ];
    expect(projectKnowledgeKey(entries[0]!)).toBe("architecture:the graph owns verification.");
    expect(renderProjectKnowledge(entries)).toBe(
      "Architecture:\n- The graph owns verification.\n\nDecisions:\n- Keep checkpoints local.",
    );
    expect(renderProjectKnowledge([])).toBe("None.");
  });
});

describe("human decision contracts", () => {
  it("accepts bounded clarification and consequential approval requests", () => {
    expect(HumanDecisionRequestSchema.parse({
      id: "decision-1",
      kind: "clarification",
      question: "Which storage backend should be used?",
      context: "The repository supports either local SQLite or Postgres.",
      options: [
        { id: "sqlite", label: "SQLite", description: "Keep setup local and simple." },
        { id: "postgres", label: "Postgres", description: "Use the deployed database." },
      ],
      allowCustom: true,
    })).toMatchObject({ id: "decision-1", kind: "clarification" });

    expect(HumanDecisionRequestSchema.parse({
      id: "decision-2",
      kind: "approval",
      question: "Approve replacing the database dependency?",
      risk: "This replaces a core dependency and can change persisted data behavior.",
      action: "npm uninstall sqlite3 && npm install better-sqlite3",
      options: [
        { id: "approve", label: "Approve", description: "Run this exact action once." },
        { id: "reject", label: "Reject", description: "Cancel this action." },
        { id: "edit", label: "Edit", description: "Provide a safer replacement instruction." },
      ],
      allowCustom: true,
    })).toMatchObject({ id: "decision-2", kind: "approval" });
  });

  it("rejects malformed or semantically invalid decisions", () => {
    const request = {
      id: "decision-1",
      kind: "approval",
      question: "Choose one",
      action: "npm uninstall sqlite3",
      options: [
        { id: "approve", label: "Approve", description: "Run once" },
        { id: "reject", label: "Reject", description: "Cancel" },
        { id: "edit", label: "Edit", description: "Change it" },
      ],
      allowCustom: true,
    } as const;
    expect(() => HumanDecisionRequestSchema.parse({ ...request, secret: "nope" })).toThrow();
    expect(() => HumanDecisionRequestSchema.parse({ ...request, options: [request.options[0]] })).toThrow();
    expect(() => HumanDecisionRequestSchema.parse({ ...request, allowCustom: false })).toThrow();
    expect(() => HumanDecisionResponseSchema.parse({ requestId: request.id, optionId: "a", customText: "also" })).toThrow();
    expect(() => HumanDecisionResponseSchema.parse({ requestId: request.id })).toThrow();
    expect(HumanDecisionResponseSchema.parse({
      requestId: request.id,
      customText: "use token=super-secret-value",
    })).toEqual({ requestId: request.id, customText: "use token=[REDACTED]" });
  });

  it("validates a response against its request", () => {
    const request = HumanDecisionRequestSchema.parse({
      id: "decision-1",
      kind: "approval",
      question: "Choose one",
      action: "npm uninstall sqlite3",
      options: [
        { id: "approve", label: "Approve", description: "Run once" },
        { id: "reject", label: "Reject", description: "Cancel" },
        { id: "edit", label: "Edit", description: "Change it" },
      ],
      allowCustom: true,
    });
    expect(HumanDecisionResponseSchema.forRequest(request).parse({
      requestId: request.id,
      optionId: "approve",
    })).toEqual({ requestId: request.id, optionId: "approve" });
    expect(() => HumanDecisionResponseSchema.forRequest(request).parse({
      requestId: request.id,
      optionId: "missing",
    })).toThrow();
    expect(HumanDecisionResponseSchema.forRequest(request).parse({
      requestId: request.id,
      customText: "Something else",
    })).toEqual({ requestId: request.id, customText: "Something else" });
  });

  it("canonicalizes approval presentation independently of provider labels and order", () => {
    const request = HumanDecisionRequestSchema.parse({
      id: "decision-adversarial",
      kind: "approval",
      question: "Approve the exact action?",
      action: "rm -rf build",
      options: [
        { id: "reject", label: "Approve", description: "Run it now." },
        { id: "edit", label: "Reject", description: "Cancel it." },
        { id: "approve", label: "Safe default", description: "Nothing will happen." },
      ],
      allowCustom: true,
    });

    expect(request.options).toEqual([
      { id: "approve", label: "Approve", description: "Run this exact action once." },
      { id: "reject", label: "Reject", description: "Cancel this action." },
      { id: "edit", label: "Edit", description: "Provide different guidance; do not run the original action." },
    ]);
  });

  it("rejects terminal-spoofing controls only from approval presentation", () => {
    const approval = {
      id: "decision-safe-terminal",
      kind: "approval" as const,
      question: "Approve the exact action?",
      action: "rm build/output.js",
      options: [
        { id: "approve", label: "Approve", description: "Run once." },
        { id: "reject", label: "Reject", description: "Cancel." },
        { id: "edit", label: "Edit", description: "Change guidance." },
      ],
      allowCustom: true,
    };

    for (const injected of [
      "line one\nline two",
      "safe\u2028txt",
      "safe\u2029txt",
      "safe\u202Etxt",
      "safe\u2066txt",
    ]) {
      expect(() => HumanDecisionRequestSchema.parse({ ...approval, question: injected })).toThrow();
      expect(() => HumanDecisionRequestSchema.parse({ ...approval, action: injected })).toThrow();
      expect(() => HumanDecisionRequestSchema.parse({ ...approval, context: injected })).toThrow();
      expect(() => HumanDecisionRequestSchema.parse({ ...approval, risk: injected })).toThrow();
      expect(() => HumanDecisionRequestSchema.parse({
        ...approval,
        options: approval.options.map((option, index) => index === 0 ? { ...option, label: injected } : option),
      })).toThrow();
      expect(() => HumanDecisionRequestSchema.parse({
        ...approval,
        options: approval.options.map((option, index) => index === 0 ? { ...option, description: injected } : option),
      })).toThrow();
    }

    expect(HumanDecisionRequestSchema.parse({
      id: "clarification-multiline",
      kind: "clarification",
      question: "Compare these choices:\n- local\n- hosted",
      options: [
        { id: "local", label: "Local", description: "Keep data here." },
        { id: "hosted", label: "Hosted", description: "Use remote storage." },
      ],
      allowCustom: true,
    }).question).toContain("\n");
  });
});

describe("secret redaction", () => {
  it("redacts credentialed URI userinfo and database URL assignments", () => {
    const raw = [
      "postgres://db-user:s3cr%40t@db.example.test/app",
      "https://api-user:api-pass@example.test/path",
      "DATABASE_URL=postgres://owner:hunter2@localhost/app",
      "TEST_DATABASE_URL='mysql://test-user:test-pass@localhost/test'",
    ].join("\n");

    const redacted = redactSecrets(raw);

    expect(redacted).not.toMatch(/db-user|s3cr%40t|api-user|api-pass|owner|hunter2|test-user|test-pass/u);
    expect(redacted).toContain("postgres://[REDACTED]@db.example.test/app");
    expect(redacted).toContain("DATABASE_URL=[REDACTED]");
    expect(redacted).toContain("TEST_DATABASE_URL=[REDACTED]");
  });
});

describe("human decision checkpoint recovery", () => {
  it("visibly canonicalizes legacy multiline approval presentation", () => {
    const recovered = recoverHumanDecisionRequest({
      id: "legacy-approval",
      kind: "approval",
      question: "Approve this?\nLegacy detail",
      context: "Context line one\r\nContext line two",
      risk: "Risk line one\u2028Risk line two\u2029End",
      action: "npm run migrate",
      options: [
        { id: "approve", label: "Approve", description: "Run once." },
        { id: "reject", label: "Reject", description: "Cancel." },
        { id: "edit", label: "Edit", description: "Change guidance." },
      ],
      allowCustom: true,
    });

    expect(recovered).not.toBeNull();
    expect(recovered?.question).toBe("Approve this?\\u{000a}Legacy detail");
    expect(recovered?.context).toBe("Context line one\\u{000d}\\u{000a}Context line two");
    expect(recovered?.risk).toBe("Risk line one\\u{2028}Risk line two\\u{2029}End");
  });
});

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

  it("applies bounded session defaults", () => {
    expect(SessionContextSchema.parse({ sessionId: "session-1" })).toEqual({
      sessionId: "session-1",
      olderSummary: "",
      compactionCount: 0,
      lastCompactedAt: null,
      recentTurns: [],
      runSummaries: [],
    });
    const persistedSummary = {
      runId: "run-1",
      status: "completed",
      objective: "Build the feature",
      summary: "Feature built",
    };
    expect(
      SessionContextSchema.parse({
        sessionId: "session-1",
        runSummaries: [persistedSummary],
      }).runSummaries,
    ).toEqual([persistedSummary]);
    expect(() =>
      SessionContextSchema.parse({
        sessionId: "session-1",
        runSummaries: [{ ...persistedSummary, status: "cancelled" }],
      }),
    ).toThrow();

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

  it("accepts finalization failures", () => {
    expect(
      FailureContextSchema.parse({
        stage: "finalizing",
        message: "Could not persist terminal state",
      }),
    ).toMatchObject({ stage: "finalizing" });
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
    { type: "assistant_text_delta", delta: "Working", done: false },
    { type: "assistant_text_delta", delta: "", done: true },
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
