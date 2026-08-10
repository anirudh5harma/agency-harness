import type { AgencyEvent, RunState, SessionContext } from "../domain/index.js";
import type { EventBus } from "../events/index.js";
import type { CodingRunState } from "../graph/index.js";
import type { RepositoryInspection } from "../repo/index.js";

export interface TextOutput {
  write(text: string): void;
}

export interface TerminalRenderer {
  header(inspection: RepositoryInspection): void;
  event(event: AgencyEvent): void;
  run(state: CodingRunState): void;
  status(input: {
    inspection: RepositoryInspection;
    session: SessionContext;
    changedFiles: readonly string[];
  }): void;
  diff(text: string): void;
  verification(result: NonNullable<RunState["verification"]>): void;
  recovery(message: string): void;
  message(message: string): void;
  error(message: string): void;
  dispose(): void;
}

function line(output: TextOutput, value = ""): void {
  output.write(`${value}\n`);
}

export class PlainTerminalRenderer implements TerminalRenderer {
  readonly #output: TextOutput;
  readonly #errorOutput: TextOutput;
  readonly #unsubscribe: Array<() => void> = [];
  #disposed = false;

  constructor(output: TextOutput, errorOutput: TextOutput, eventBus?: EventBus) {
    this.#output = output;
    this.#errorOutput = errorOutput;
    if (eventBus !== undefined) {
      for (const type of [
        "phase",
        "tool",
        "file_changed",
        "command_started",
        "command_finished",
        "message",
        "error",
      ] as const) {
        this.#unsubscribe.push(eventBus.subscribe(type, (event) => this.event(event)));
      }
    }
  }

  header(inspection: RepositoryInspection): void {
    const branch = inspection.currentBranch ?? "detached HEAD";
    line(this.#output, "Agency");
    line(this.#output, `Project: ${inspection.rootPath}`);
    line(this.#output, `Branch: ${branch} (${inspection.isDirty ? "dirty" : "clean"})`);
  }

  event(event: AgencyEvent): void {
    if (event.type === "phase") line(this.#output, `Phase: ${event.phase}`);
    else if (event.type === "tool") {
      line(this.#output, `Tool: ${event.tool}${event.detail === undefined ? "" : ` — ${event.detail}`}`);
    }
    else if (event.type === "file_changed") line(this.#output, `Changed: ${event.path}`);
    else if (event.type === "command_started") line(this.#output, `Running: ${event.command}`);
    else if (event.type === "command_finished") {
      line(this.#output, `Command ${event.exitCode === 0 ? "passed" : "failed"}: ${event.command}`);
    } else if (event.type === "message") line(this.#output, event.content);
    else if (event.type === "error") this.error(event.message);
  }

  run(state: CodingRunState): void {
    if (state.codingPlan !== null) {
      line(this.#output, `Plan: ${state.codingPlan.objective}`);
      for (const step of state.codingPlan.steps) {
        line(this.#output, `  ${step.id}. ${step.description}`);
      }
    }
    line(
      this.#output,
      state.changedFiles.length === 0
        ? "Changed files: none"
        : `Changed files: ${state.changedFiles.join(", ")}`,
    );
    if (state.verification !== null) {
      line(
        this.#output,
        `Verification: ${state.verification.status} — ${state.verification.summary}`,
      );
    } else {
      line(this.#output, "Verification: not completed");
    }
    if (state.status === "completed") {
      line(this.#output, `Done: ${state.summary}`);
    } else if (state.status === "cancelled") {
      line(this.#output, "Cancelled.");
    } else {
      line(this.#errorOutput, `Failed: ${state.summary || state.failure?.message || "unknown error"}`);
    }
  }

  status(input: {
    inspection: RepositoryInspection;
    session: SessionContext;
    changedFiles: readonly string[];
  }): void {
    const last = input.session.runSummaries.at(-1);
    line(this.#output, `Project: ${input.inspection.rootPath}`);
    line(this.#output, `Session: ${input.session.sessionId}`);
    line(this.#output, `Last task: ${last?.objective ?? "none"}`);
    line(this.#output, `Status: ${last?.status ?? "idle"}`);
    line(this.#output, `Verification: ${last?.verification?.status ?? "none"}`);
    line(
      this.#output,
      (last?.changedFiles ?? input.changedFiles).length === 0
        ? "Changed files: none"
        : `Changed files: ${(last?.changedFiles ?? input.changedFiles).join(", ")}`,
    );
  }

  diff(text: string): void {
    line(this.#output, text.trim() === "" ? "No Git diff." : text.trimEnd());
  }

  verification(result: NonNullable<RunState["verification"]>): void {
    line(this.#output, `Verification: ${result.status} — ${result.summary}`);
    for (const command of result.commands) {
      line(
        this.#output,
        `  ${[command.command, ...command.args].join(" ")}: ${command.exitCode === 0 ? "passed" : "failed"}`,
      );
    }
  }

  recovery(message: string): void {
    line(this.#output, `Recovery: ${message}`);
  }

  message(message: string): void {
    line(this.#output, message);
  }

  error(message: string): void {
    line(this.#errorOutput, `Error: ${message}`);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
  }
}
