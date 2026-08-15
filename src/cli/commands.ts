import type { SessionContext, VerificationResult } from "../domain/index.js";
import type { SessionCompactionResult } from "../session/index.js";
import { detectNodeVerificationConfiguration, runCommand, VerificationRunner } from "../process/index.js";
import { inspectRepository, type RepositoryInspection } from "../repo/index.js";
import {
  GitCheckpointManager,
  type AgencyWorktreeContext,
} from "../repo/index.js";
import type { TerminalRenderer } from "./renderer.js";
import { POLICY_DISPLAY } from "../coding/tool-policy.js";
import {
  EvaluationStore,
  MissionKindSchema,
  aggregateEvaluations,
  type MissionKind,
} from "../evaluations/index.js";

export type SlashCommandResult = "continue" | "exit";

export interface SlashCommandDependencies {
  projectRoot: string;
  renderer: TerminalRenderer;
  getSession(): SessionContext;
  createNewSession(): Promise<SessionContext>;
  compactSession(): Promise<SessionCompactionResult>;
  inspect?: (cwd: string) => Promise<RepositoryInspection>;
  gitDiff?: (cwd: string, signal: AbortSignal) => Promise<string>;
  verify?: (cwd: string, signal: AbortSignal) => Promise<VerificationResult>;
  checkpoints?: Pick<GitCheckpointManager, "create" | "prepareUndo" | "applyUndo" | "discardUndoPlan" | "list">;
  worktree?: {
    context: AgencyWorktreeContext;
    requestDiscard(signal: AbortSignal): Promise<boolean>;
  };
  confirm?: (prompt: string, signal: AbortSignal) => Promise<boolean>;
  runMission?(kind: MissionKind, intent: string, signal: AbortSignal): Promise<void>;
  evaluations?: Pick<EvaluationStore, "listRecent">;
}

const MISSION_FOCUS: Record<MissionKind, string> = {
  tests: "the highest-value missing or weak automated test",
  "dead-code": "the highest-value safely removable dead-code item",
  simplify: "the highest-value behavior-preserving simplification",
  performance: "the highest-value measurable performance improvement",
};

export function missionIntent(kind: MissionKind): string {
  return [
    `Bounded ${kind} mission.`,
    `First inspect the repository, then choose exactly ONE ${MISSION_FOCUS[kind]} and complete only that objective.`,
    "Change at most 3 files. Preserve existing behavior except for the chosen test or measurable performance outcome.",
    "Do not add dependencies, create migrations, publish, stage, commit, push, or open a pull request.",
    "Follow all normal approval rules and finish with Agency's normal independent verification.",
  ].join(" ");
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function decimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function userChangedFiles(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.slice(3).split(" -> ").at(-1) ?? "")
    .filter((path) => path !== ".devagency" && !path.startsWith(".devagency/"));
}

export async function gitDiff(cwd: string, signal: AbortSignal): Promise<string> {
  const runGit = (args: string[]) => runCommand({
    command: "git",
    args,
    cwd,
    signal,
    timeoutMs: 30_000,
    maxOutputBytes: 512 * 1024,
  });
  const [unstaged, staged, untrackedResult] = await Promise.all([
    runGit(["diff", "--no-ext-diff", "--"]),
    runGit(["diff", "--cached", "--no-ext-diff", "--"]),
    runGit(["ls-files", "--others", "--exclude-standard", "-z", "--"]),
  ]);
  for (const result of [unstaged, staged, untrackedResult]) {
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "git diff failed");
    }
  }

  const untrackedPaths = untrackedResult.stdout
    .split("\0")
    .filter(Boolean)
    .filter((path) => path !== ".devagency" && !path.startsWith(".devagency/"));
  const untrackedDiffs: string[] = [];
  for (const path of untrackedPaths) {
    const result = await runGit(["diff", "--no-index", "--", "/dev/null", path]);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(result.stderr.trim() || `git diff failed for untracked file ${path}`);
    }
    untrackedDiffs.push(`Untracked file: ${JSON.stringify(path)}\n${result.stdout}`);
  }

  return [unstaged.stdout, staged.stdout, ...untrackedDiffs]
    .filter((section) => section !== "")
    .join("\n");
}

export async function verifyProject(
  cwd: string,
  signal: AbortSignal,
): Promise<VerificationResult> {
  const configuration = await detectNodeVerificationConfiguration(cwd);
  return new VerificationRunner({
    signal,
    requiredEnvironmentKeys: configuration.requiredEnvironmentKeys,
  }).run(configuration.commands, cwd);
}

export class SlashCommandRouter {
  readonly #dependencies: SlashCommandDependencies;

  constructor(dependencies: SlashCommandDependencies) {
    this.#dependencies = dependencies;
  }

  async execute(input: string, signal: AbortSignal): Promise<SlashCommandResult> {
    const [rawCommand, ...args] = input.trim().split(/\s+/);
    const command = rawCommand ?? "";
    if (args.length > 0 && !["/checkpoint", "/undo", "/worktree", "/mission", "/metrics"].includes(command)) {
      this.#dependencies.renderer.error(`${command} does not accept arguments.`);
      return "continue";
    }

    switch (command) {
      case "/help":
        this.#dependencies.renderer.message(
          [
            "Commands:",
            "  /help    Show this help",
            "  /status  Show project and session status",
            "  /compact Compact older session context",
            "  /diff    Show the current Git diff",
            "  /verify  Run project verification",
            "  /mission tests|dead-code|simplify|performance Run one bounded objective through the normal workflow",
            "  /metrics [last] Show aggregate or latest run evaluation metrics",
            "  /checkpoint [label] Create a Git snapshot without changing HEAD or staging",
            "  /undo [checkpoint] Restore only unchanged Agency-owned paths",
            "  /worktree [keep|discard] Show or manage isolated worktree",
            "  /tools   Collapse or expand tool activity (TTY)",
            "  /policy  Show enforced tool policy and sandbox status",
            "  /new     Start a fresh conversational session",
            "  /exit    Exit Agency",
          ].join("\n"),
        );
        return "continue";
      case "/status": {
        const inspect = this.#dependencies.inspect ?? inspectRepository;
        const inspection = await inspect(this.#dependencies.projectRoot);
        this.#dependencies.renderer.status({
          inspection,
          session: this.#dependencies.getSession(),
          changedFiles: userChangedFiles(inspection.porcelain),
        });
        return "continue";
      }
      case "/diff": {
        const diff = this.#dependencies.gitDiff ?? gitDiff;
        this.#dependencies.renderer.diff(await diff(this.#dependencies.projectRoot, signal));
        return "continue";
      }
      case "/compact": {
        const result = await this.#dependencies.compactSession();
        this.#dependencies.renderer.event({
          type: "context_compacted",
          beforeTurns: result.beforeTurns,
          afterTurns: result.afterTurns,
          beforeRunSummaries: result.beforeRunSummaries,
          afterRunSummaries: result.afterRunSummaries,
        });
        return "continue";
      }
      case "/verify": {
        const verify = this.#dependencies.verify ?? verifyProject;
        this.#dependencies.renderer.verification(
          await verify(this.#dependencies.projectRoot, signal),
        );
        return "continue";
      }
      case "/mission": {
        if (args.length !== 1) {
          this.#dependencies.renderer.error("Usage: /mission tests|dead-code|simplify|performance");
          return "continue";
        }
        const kind = args[0] ?? "";
        const parsed = MissionKindSchema.safeParse(kind);
        if (!parsed.success) {
          this.#dependencies.renderer.error(`Unknown mission: ${kind}. Available: tests, dead-code, simplify, performance.`);
          return "continue";
        }
        if (this.#dependencies.runMission === undefined) throw new Error("Mission execution is unavailable");
        await this.#dependencies.runMission(parsed.data, missionIntent(parsed.data), signal);
        return "continue";
      }
      case "/metrics": {
        if (args.length > 1 || (args[0] !== undefined && args[0] !== "last")) {
          this.#dependencies.renderer.error("Usage: /metrics [last]");
          return "continue";
        }
        const store = this.#dependencies.evaluations ?? new EvaluationStore(this.#dependencies.projectRoot);
        const result = await store.listRecent(args[0] === "last" ? 1 : 100);
        if (args[0] === "last") {
          const last = result.evaluations[0];
          this.#dependencies.renderer.message(last === undefined
            ? "Metrics: no evaluations recorded."
            : [
                `Metrics last: ${last.runId} — ${last.status}${last.mission === undefined ? "" : ` (${last.mission} mission)`}`,
                `Duration: ${decimal(last.durationMs)}ms; repairs: ${last.repairAttempts}; tools: ${last.toolCalls}; model calls: ${last.modelCalls.total}; files: ${last.changedFileCount}`,
                `Verification: ${last.verification.status} (${last.verification.commandCount} commands); human decisions: ${last.humanDecisionCount}`,
              ].join("\n"));
        } else {
          const aggregate = aggregateEvaluations(result.evaluations);
          this.#dependencies.renderer.message([
            `Metrics: ${aggregate.runs} recent run${aggregate.runs === 1 ? "" : "s"}`,
            `Success: ${percentage(aggregate.successRate)}; verification pass: ${percentage(aggregate.verificationPassRate)}`,
            `Averages: ${decimal(aggregate.averageDurationMs)}ms; repairs ${decimal(aggregate.averageRepairAttempts)}; tools ${decimal(aggregate.averageToolCalls)}; model calls ${decimal(aggregate.averageModelCalls)}; files ${decimal(aggregate.averageChangedFiles)}`,
            ...(result.corruptCount === 0 ? [] : [`Skipped corrupt evaluations: ${result.corruptCount}`]),
          ].join("\n"));
        }
        return "continue";
      }
      case "/checkpoint": {
        const checkpoints = this.#dependencies.checkpoints ?? new GitCheckpointManager(this.#dependencies.projectRoot);
        const checkpoint = await checkpoints.create(args.join(" ") || undefined);
        this.#dependencies.renderer.message(`Checkpoint ${checkpoint.id} created at ${checkpoint.ref}. HEAD and staging unchanged.`);
        return "continue";
      }
      case "/undo": {
        if (args.length > 1) {
          this.#dependencies.renderer.error("/undo accepts at most one checkpoint id.");
          return "continue";
        }
        const checkpoints = this.#dependencies.checkpoints ?? new GitCheckpointManager(this.#dependencies.projectRoot);
        const plan = await checkpoints.prepareUndo(args[0]);
        let allowDeletes = false;
        if (plan.deletionsRequired.length > 0) {
          const quoted = plan.deletionsRequired.map((path) => JSON.stringify(path)).join(", ");
          const confirmed = await this.#dependencies.confirm?.(`Undo will delete ${plan.deletionsRequired.length} path(s): ${quoted}. Type yes to continue: `, signal) ?? false;
          if (!confirmed) {
            await checkpoints.discardUndoPlan(plan);
            this.#dependencies.renderer.message("Undo cancelled; no files changed.");
            return "continue";
          }
          allowDeletes = true;
        }
        const result = await checkpoints.applyUndo(plan, { allowDeletes });
        this.#dependencies.renderer.message(
          `Undo ${result.checkpointId}: restored ${result.restored.length}; refused ${result.diverged.length} diverged path${result.diverged.length === 1 ? "" : "s"}.${result.diverged.length === 0 ? "" : ` ${result.diverged.join(", ")}`}`,
        );
        return "continue";
      }
      case "/worktree": {
        if (args.length > 1 || (args[0] !== undefined && args[0] !== "keep" && args[0] !== "discard")) {
          this.#dependencies.renderer.error("Usage: /worktree [keep|discard]");
          return "continue";
        }
        const worktree = this.#dependencies.worktree;
        if (worktree === undefined) {
          this.#dependencies.renderer.message("Worktree: direct checkout. Start Agency with --worktree for isolation.");
          return "continue";
        }
        if (args[0] === "discard") {
          return (await worktree.requestDiscard(signal)) ? "exit" : "continue";
        }
        this.#dependencies.renderer.message(
          `Worktree: ${worktree.context.path}\nBranch: ${worktree.context.branch}\nPreserved on exit${args[0] === "keep" ? " (keep selected)" : ""}.`,
        );
        return "continue";
      }
      case "/tools":
        this.#dependencies.renderer.toggleToolActivity();
        return "continue";
      case "/policy":
        this.#dependencies.renderer.message(POLICY_DISPLAY);
        return "continue";
      case "/new": {
        const session = await this.#dependencies.createNewSession();
        this.#dependencies.renderer.message(`New session: ${session.sessionId}`);
        return "continue";
      }
      case "/exit":
        return "exit";
      default:
        this.#dependencies.renderer.error(
          `Unknown command: ${command}. Use /help to list commands.`,
        );
        return "continue";
    }
  }
}
