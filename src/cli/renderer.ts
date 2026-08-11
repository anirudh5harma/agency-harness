import { basename } from "node:path";

import type { AgencyEvent, SessionContext, VerificationResult } from "../domain/index.js";
import type { EventBus } from "../events/index.js";
import type { CodingRunState } from "../graph/index.js";
import type { RepositoryInspection } from "../repo/index.js";

export interface TextOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(text: string): void;
}

export interface TerminalRenderer {
  header(inspection: RepositoryInspection, session?: SessionContext): void;
  event(event: AgencyEvent): void;
  run(state: CodingRunState): void;
  status(input: {
    inspection: RepositoryInspection;
    session: SessionContext;
    changedFiles: readonly string[];
  }): void;
  diff(text: string): void;
  verification(result: VerificationResult): void;
  recovery(message: string): void;
  message(message: string): void;
  error(message: string): void;
  toggleToolActivity(): void;
  setSession(session: SessionContext): void;
  setRunStatus(status: "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled"): void;
  beforeInput(): void;
  redraw(): void;
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
  #assistantStreaming = false;
  #assistantAtLineStart = true;

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
        "assistant_text_delta",
        "context_compacted",
        "error",
        "human_input_requested",
        "human_input_resolved",
      ] as const) {
        this.#unsubscribe.push(eventBus.subscribe(type, (event) => this.event(event)));
      }
    }
  }

  header(inspection: RepositoryInspection): void {
    this.#flushAssistant();
    const branch = inspection.currentBranch ?? "detached HEAD";
    line(this.#output, "Agency");
    line(this.#output, `Project: ${inspection.rootPath}`);
    line(this.#output, `Branch: ${branch} (${inspection.isDirty ? "dirty" : "clean"})`);
  }

  event(event: AgencyEvent): void {
    if (event.type === "assistant_text_delta") {
      this.#streamAssistant(event.delta, event.done);
      return;
    }
    this.#flushAssistant();
    if (event.type === "phase") line(this.#output, `Phase: ${event.phase}`);
    else if (event.type === "tool") {
      line(this.#output, `Tool: ${event.tool}${event.detail === undefined ? "" : ` — ${event.detail}`}`);
    }
    else if (event.type === "file_changed") line(this.#output, `Changed: ${event.path}`);
    else if (event.type === "command_started") line(this.#output, `Running: ${event.command}`);
    else if (event.type === "command_finished") {
      line(this.#output, `Command ${event.exitCode === 0 ? "passed" : "failed"}: ${event.command}`);
    } else if (event.type === "human_input_requested") {
      line(this.#output, `${event.kind === "approval" ? "Approval needed" : "Clarification needed"}: ${event.question}`);
    } else if (event.type === "human_input_resolved") {
      line(this.#output, `Human input resolved: ${event.resolution}`);
    } else if (event.type === "message") line(this.#output, event.content);
    else if (event.type === "context_compacted") {
      line(this.#output, `Context compacted: turns ${event.beforeTurns}→${event.afterTurns}, run summaries ${event.beforeRunSummaries}→${event.afterRunSummaries}.`);
    }
    else if (event.type === "error") this.error(event.message);
  }

  run(state: CodingRunState): void {
    this.#flushAssistant();
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
    this.#flushAssistant();
    const last = input.session.runSummaries.at(-1);
    line(this.#output, `Project: ${input.inspection.rootPath}`);
    line(this.#output, `Session: ${input.session.sessionId}`);
    line(this.#output, `Last task: ${last?.objective ?? "none"}`);
    line(this.#output, `Status: ${last?.status ?? "idle"}`);
    line(this.#output, `Verification: ${last?.verification?.status ?? "none"}`);
    line(this.#output, `Context: ${input.session.recentTurns.length} recent turns, ${input.session.runSummaries.length} recent runs, ${input.session.olderSummary === "" ? "no" : "yes"} older summary (${input.session.compactionCount} compactions)`);
    line(
      this.#output,
      (last?.changedFiles ?? input.changedFiles).length === 0
        ? "Changed files: none"
        : `Changed files: ${(last?.changedFiles ?? input.changedFiles).join(", ")}`,
    );
  }

  diff(text: string): void {
    this.#flushAssistant();
    line(this.#output, text.trim() === "" ? "No Git diff." : text.trimEnd());
  }

  verification(result: VerificationResult): void {
    this.#flushAssistant();
    line(this.#output, `Verification: ${result.status} — ${result.summary}`);
    for (const command of result.commands) {
      line(
        this.#output,
        `  ${[command.command, ...command.args].join(" ")}: ${command.exitCode === 0 ? "passed" : "failed"}`,
      );
    }
  }

  recovery(message: string): void {
    this.#flushAssistant();
    line(this.#output, `Recovery: ${message}`);
  }

  message(message: string): void {
    this.#flushAssistant();
    line(this.#output, message);
  }

  error(message: string): void {
    this.#flushAssistant();
    line(this.#errorOutput, `Error: ${message}`);
  }

  toggleToolActivity(): void {
    line(this.#output, "Tool activity is always shown in plain output.");
  }

  setSession(): void {}

  setRunStatus(): void {}

  beforeInput(): void { this.#flushAssistant(); }

  redraw(): void {}

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#flushAssistant();
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
  }

  #streamAssistant(delta: string, done: boolean): void {
    this.#assistantStreaming = true;
    if (delta !== "") {
      this.#output.write(delta);
      this.#assistantAtLineStart = delta.endsWith("\n");
    }
    if (done) this.#flushAssistant();
  }

  #flushAssistant(): void {
    if (!this.#assistantStreaming) return;
    if (!this.#assistantAtLineStart) this.#output.write("\n");
    this.#assistantStreaming = false;
    this.#assistantAtLineStart = true;
  }
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  eraseLine: "\r\u001b[2K",
  clearScreen: "\u001b[2J\u001b[H",
} as const;

type RunStatus = Parameters<TerminalRenderer["setRunStatus"]>[0];

function terminalText(value: string): string {
  return [...value].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === "\n" || character === "\t" ||
      (codePoint >= 32 && codePoint < 127) || codePoint >= 160;
  }).join("");
}

function characterWidth(character: string): number {
  if (/\p{Mark}/u.test(character)) return 0;
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) ? 2 : 1;
}

function fitTerminalWidth(value: string, width: number): string {
  const target = Math.max(1, Math.floor(width));
  let used = 0;
  const result: string[] = [];
  for (const character of value) {
    const next = used + characterWidth(character);
    if (next > target) {
      while (used + 1 > target && result.length > 0) {
        const removed = result.pop();
        if (removed !== undefined) used -= characterWidth(removed);
      }
      return `${result.join("")}…`;
    }
    result.push(character);
    used = next;
  }
  return result.join("");
}

function richEventLine(event: AgencyEvent): string | null {
  if (event.type === "phase") return `${ANSI.cyan}Phase:${ANSI.reset} ${event.phase}`;
  if (event.type === "tool") {
    return `${ANSI.yellow}Tool:${ANSI.reset} ${terminalText(event.tool)}${event.detail === undefined ? "" : ` — ${terminalText(event.detail)}`}`;
  }
  if (event.type === "file_changed") return `${ANSI.yellow}Changed:${ANSI.reset} ${terminalText(event.path)}`;
  if (event.type === "command_started") return `${ANSI.cyan}Running:${ANSI.reset} ${terminalText(event.command)}`;
  if (event.type === "command_finished") {
    const color = event.exitCode === 0 ? ANSI.green : ANSI.red;
    return `${color}Command ${event.exitCode === 0 ? "passed" : "failed"}:${ANSI.reset} ${terminalText(event.command)}`;
  }
  if (event.type === "human_input_requested") {
    return `${ANSI.yellow}${event.kind === "approval" ? "Approval needed" : "Clarification needed"}:${ANSI.reset} ${terminalText(event.question)}`;
  }
  if (event.type === "human_input_resolved") return `Human input resolved: ${event.resolution}`;
  if (event.type === "message") return terminalText(event.content);
  if (event.type === "context_compacted") {
    return `Context compacted: turns ${event.beforeTurns}→${event.afterTurns}, run summaries ${event.beforeRunSummaries}→${event.afterRunSummaries}.`;
  }
  return null;
}

/** ANSI renderer used only for interactive TTY output. Graph and event contracts stay unchanged. */
export class RichTerminalRenderer implements TerminalRenderer {
  readonly #output: TextOutput;
  readonly #errorOutput: TextOutput;
  readonly #unsubscribe: Array<() => void> = [];
  readonly #toolEvents: Extract<AgencyEvent, { type: "tool" }>[] = [];
  #inspection: RepositoryInspection | null = null;
  #session: SessionContext | null = null;
  #phase: string | null = null;
  #runStatus: RunStatus = "idle";
  #toolsVisible = true;
  #renderedToolCount = 0;
  #statusVisible = false;
  #disposed = false;
  #assistantStreaming = false;
  #assistantAtLineStart = true;

  constructor(output: TextOutput, errorOutput: TextOutput, eventBus?: EventBus) {
    this.#output = output;
    this.#errorOutput = errorOutput;
    if (eventBus !== undefined) {
      for (const type of [
        "phase", "tool", "file_changed", "command_started", "command_finished", "message",
        "assistant_text_delta",
        "context_compacted", "error", "human_input_requested", "human_input_resolved",
      ] as const) {
        this.#unsubscribe.push(eventBus.subscribe(type, (event) => this.event(event)));
      }
    }
  }

  header(inspection: RepositoryInspection, session?: SessionContext): void {
    this.#inspection = inspection;
    this.#session = session ?? null;
    const branch = inspection.currentBranch ?? "detached HEAD";
    const title = ` Agency · ${terminalText(inspection.project.name)} `;
    const width = Math.max(42, title.length + 4);
    const top = `┌${title}${"─".repeat(Math.max(0, width - title.length - 1))}┐`;
    const project = `│ ${terminalText(inspection.rootPath)}`;
    const branchLine = `│ ${terminalText(branch)} · ${inspection.isDirty ? "dirty" : "clean"}`;
    this.#writeBlock(
      `${ANSI.cyan}${ANSI.bold}${top}${ANSI.reset}\n${project}\n${branchLine}\n` +
      `${ANSI.cyan}└${"─".repeat(width)}┘${ANSI.reset}\n` +
      `${ANSI.dim}Multiline: end a line with \\ · /help for commands${ANSI.reset}`,
      false,
    );
  }

  event(event: AgencyEvent): void {
    if (event.type === "assistant_text_delta") {
      this.#streamAssistant(event.delta, event.done);
      return;
    }
    this.#flushAssistant();
    if (event.type === "phase") this.#phase = event.phase;
    if (event.type === "tool") {
      this.#toolEvents.push(event);
      if (!this.#toolsVisible) {
        this.#drawStatus();
        return;
      }
    }
    if (event.type === "error") {
      this.error(event.message);
      return;
    }
    const value = richEventLine(event);
    if (value !== null) this.#writeBlock(value, true);
    if (event.type === "tool") this.#renderedToolCount = this.#toolEvents.length;
  }

  run(state: CodingRunState): void {
    this.setRunStatus(
      state.status === "completed" || state.status === "failed" || state.status === "cancelled"
        ? state.status
        : "running",
    );
    const parts: string[] = [];
    if (state.codingPlan !== null) {
      parts.push(`${ANSI.bold}Plan:${ANSI.reset} ${terminalText(state.codingPlan.objective)}`);
      parts.push(...state.codingPlan.steps.map((step) => `  ${terminalText(step.id)}. ${terminalText(step.description)}`));
    }
    parts.push(state.changedFiles.length === 0 ? "Changed files: none" : `Changed files: ${terminalText(state.changedFiles.join(", "))}`);
    parts.push(state.verification === null
      ? "Verification: not completed"
      : `Verification: ${state.verification.status} — ${terminalText(state.verification.summary)}`);
    if (state.status === "completed") parts.push(`${ANSI.green}Done:${ANSI.reset} ${terminalText(state.summary)}`);
    else if (state.status === "cancelled") parts.push(`${ANSI.yellow}Cancelled.${ANSI.reset}`);
    else parts.push(`${ANSI.red}Failed:${ANSI.reset} ${terminalText(state.summary || state.failure?.message || "unknown error")}`);
    this.#writeBlock(parts.join("\n"), true);
  }

  status(input: { inspection: RepositoryInspection; session: SessionContext; changedFiles: readonly string[] }): void {
    this.#inspection = input.inspection;
    this.#session = input.session;
    const last = input.session.runSummaries.at(-1);
    this.#writeBlock([
      `Project: ${terminalText(input.inspection.rootPath)}`,
      `Branch: ${terminalText(input.inspection.currentBranch ?? "detached HEAD")}`,
      `Session: ${terminalText(input.session.sessionId)}`,
      `Last task: ${terminalText(last?.objective ?? "none")}`,
      `Status: ${last?.status ?? "idle"}`,
      `Verification: ${last?.verification?.status ?? "none"}`,
      `Context: ${input.session.recentTurns.length} recent turns, ${input.session.runSummaries.length} recent runs, ${input.session.olderSummary === "" ? "no" : "yes"} older summary (${input.session.compactionCount} compactions)`,
      (last?.changedFiles ?? input.changedFiles).length === 0
        ? "Changed files: none"
        : `Changed files: ${terminalText((last?.changedFiles ?? input.changedFiles).join(", "))}`,
    ].join("\n"), true);
  }

  diff(text: string): void {
    if (text.trim() === "") {
      this.#writeBlock("No Git diff.", true);
      return;
    }
    const highlighted = terminalText(text).trimEnd().split("\n").map((value) => {
      if (value.startsWith("@@")) return `${ANSI.cyan}${value}${ANSI.reset}`;
      if (value.startsWith("+") && !value.startsWith("+++")) return `${ANSI.green}${value}${ANSI.reset}`;
      if (value.startsWith("-") && !value.startsWith("---")) return `${ANSI.red}${value}${ANSI.reset}`;
      return value;
    }).join("\n");
    this.#writeBlock(highlighted, true);
  }

  verification(result: VerificationResult): void {
    const color = result.status === "passed" ? ANSI.green : ANSI.red;
    this.#writeBlock([
      `${color}Verification: ${result.status}${ANSI.reset} — ${terminalText(result.summary)}`,
      ...result.commands.map((command) => `  ${terminalText([command.command, ...command.args].join(" "))}: ${command.exitCode === 0 ? "passed" : "failed"}`),
    ].join("\n"), true);
  }

  recovery(message: string): void { this.#writeBlock(`${ANSI.yellow}Recovery:${ANSI.reset} ${terminalText(message)}`, true); }
  message(message: string): void { this.#writeBlock(terminalText(message), true); }

  error(message: string): void {
    this.#flushAssistant();
    this.#clearStatus();
    const prefix = this.#errorOutput.isTTY === true
      ? `${ANSI.red}Error:${ANSI.reset}`
      : "Error:";
    line(this.#errorOutput, `${prefix} ${terminalText(message)}`);
    this.#drawStatus();
  }

  toggleToolActivity(): void {
    this.#toolsVisible = !this.#toolsVisible;
    if (this.#toolsVisible) {
      const hiddenEvents = this.#toolEvents.slice(this.#renderedToolCount);
      this.#writeBlock(`Tool activity expanded (${hiddenEvents.length} hidden events).`, false);
      for (const event of hiddenEvents) {
        const value = richEventLine(event);
        if (value !== null) this.#writeBlock(value, false);
      }
      this.#renderedToolCount = this.#toolEvents.length;
      this.#drawStatus();
    } else {
      this.#writeBlock("Tool activity collapsed. /tools expands it.", true);
    }
  }

  setSession(session: SessionContext): void {
    this.#session = session;
    if (this.#statusVisible) this.#drawStatus();
  }

  setRunStatus(status: RunStatus): void {
    this.#runStatus = status;
    if (status !== "running" && status !== "waiting") this.#phase = null;
    if (this.#statusVisible) this.#drawStatus();
  }

  beforeInput(): void {
    this.#flushAssistant();
    if (!this.#statusVisible) return;
    this.#clearStatus();
    line(this.#output, this.#statusText());
  }

  redraw(): void {
    this.#clearStatus();
    this.#output.write(ANSI.clearScreen);
    if (this.#inspection !== null) {
      if (this.#session === null) this.header(this.#inspection);
      else this.header(this.#inspection, this.#session);
    }
    this.#drawStatus();
    this.beforeInput();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#flushAssistant();
    this.beforeInput();
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
  }

  #writeBlock(value: string, statusAfter: boolean): void {
    this.#flushAssistant(false);
    this.#clearStatus();
    line(this.#output, value);
    if (statusAfter) this.#drawStatus();
  }

  #clearStatus(): void {
    if (!this.#statusVisible) return;
    this.#output.write(ANSI.eraseLine);
    this.#statusVisible = false;
  }

  #drawStatus(): void {
    this.#clearStatus();
    this.#output.write(this.#statusText());
    this.#statusVisible = true;
  }

  #statusText(): string {
    const repo = this.#inspection === null ? "agency" : basename(this.#inspection.rootPath);
    const branch = terminalText(this.#inspection?.currentBranch ?? "detached");
    const session = terminalText(this.#session?.sessionId.slice(0, 12) ?? "none");
    const phase = this.#phase === null ? this.#runStatus : `${this.#runStatus}:${this.#phase}`;
    const tools = this.#toolsVisible ? "" : ` | tools ${this.#toolEvents.length} hidden`;
    const repoPart = fitTerminalWidth(terminalText(repo), 10);
    const branchPart = fitTerminalWidth(branch, 18);
    const phasePart = fitTerminalWidth(phase, 16);
    const plain = ` ${repoPart} | ${branchPart} | session ${session} | ${phasePart}${tools} | agency>…`;
    const fitted = this.#output.columns === undefined
      ? plain
      : fitTerminalWidth(plain, Math.max(1, this.#output.columns - 1));
    return `${ANSI.eraseLine}${ANSI.dim}${fitted}${ANSI.reset}`;
  }

  #streamAssistant(delta: string, done: boolean): void {
    if (!this.#assistantStreaming) {
      this.#clearStatus();
      this.#assistantStreaming = true;
    }
    const safe = terminalText(delta);
    if (safe !== "") {
      this.#output.write(safe);
      this.#assistantAtLineStart = safe.endsWith("\n");
    }
    if (done) this.#flushAssistant();
  }

  #flushAssistant(drawStatus = true): void {
    if (!this.#assistantStreaming) return;
    if (!this.#assistantAtLineStart) this.#output.write("\n");
    this.#assistantStreaming = false;
    this.#assistantAtLineStart = true;
    if (drawStatus) this.#drawStatus();
  }
}

export function createTerminalRenderer(
  output: TextOutput,
  errorOutput: TextOutput,
  eventBus?: EventBus,
): TerminalRenderer {
  return output.isTTY === true
    ? new RichTerminalRenderer(output, errorOutput, eventBus)
    : new PlainTerminalRenderer(output, errorOutput, eventBus);
}
