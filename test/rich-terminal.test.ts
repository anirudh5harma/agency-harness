import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import {
  AgencyRepl,
  createTerminalRenderer,
  layoutTerminalText,
  PlainTerminalRenderer,
  ReadlineTerminalIO,
  RichTerminalRenderer,
  type ReplHandler,
  type TerminalIO,
  type TextOutput,
} from "../src/cli/index.js";
import { EventBus } from "../src/events/index.js";
import type { RepositoryInspection } from "../src/repo/index.js";

class BufferOutput implements TextOutput {
  value = "";
  write(text: string): void {
    this.value += text;
  }
}

class TtyBufferOutput extends BufferOutput {
  readonly isTTY = true;
  readonly columns = 80;
}

const inspection: RepositoryInspection = {
  rootPath: "/work/agency",
  currentBranch: "feat/terminal-ui",
  defaultBranch: "main",
  isDirty: true,
  project: { name: "agency", languages: ["TypeScript"], scripts: {} },
  porcelain: " M src/cli/renderer.ts",
  instructionFiles: [],
  packageJsonPath: "/work/agency/package.json",
};

describe("rich terminal rendering", () => {
  it("selects rich output only for a TTY", () => {
    expect(createTerminalRenderer(new TtyBufferOutput(), new BufferOutput()))
      .toBeInstanceOf(RichTerminalRenderer);
    expect(createTerminalRenderer(new BufferOutput(), new BufferOutput()))
      .toBeInstanceOf(PlainTerminalRenderer);
  });

  it("keeps plain output byte-stable and free of ANSI", () => {
    const output = new BufferOutput();
    const renderer = new PlainTerminalRenderer(output, new BufferOutput());

    renderer.header(inspection);
    renderer.diff("@@ -1 +1 @@\n-old\n+new\n context\n");

    expect(output.value).toBe(
      "Agency\nProject: /work/agency\nBranch: feat/terminal-ui (dirty)\n" +
      "@@ -1 +1 @@\n-old\n+new\n context\n",
    );
    expect(output.value).not.toContain("\u001b[");
  });

  it("streams plain assistant chunks on one logical line and flushes before later events", () => {
    const output = new BufferOutput();
    const events = new EventBus();
    const renderer = new PlainTerminalRenderer(output, new BufferOutput(), events);

    events.emit({ type: "assistant_text_delta", delta: "Hello", done: false });
    events.emit({ type: "assistant_text_delta", delta: " world", done: false });
    expect(output.value).toBe("Hello world");
    events.emit({ type: "assistant_text_delta", delta: "", done: true });
    events.emit({ type: "phase", phase: "verifying" });

    expect(output.value).toBe("Hello world\nPhase: verifying\n");
    renderer.dispose();
  });

  it("uses ANSI borders, live status, and syntax-highlighted diff in TTY mode", () => {
    const output = new TtyBufferOutput();
    const events = new EventBus();
    const renderer = new RichTerminalRenderer(output, output, events);

    renderer.header(inspection, {
      sessionId: "session-123456789",
      recentTurns: [],
      runSummaries: [],
    });
    renderer.setRunStatus("running");
    events.emit({ type: "phase", phase: "executing" });
    renderer.diff("@@ -1 +1 @@\n-old\n+new\n context");
    renderer.message("provider text\u001b[2J stays text");

    expect(output.value).toContain("\u001b[36m");
    expect(output.value).toContain("\u001b[31m-old\u001b[0m");
    expect(output.value).toContain("\u001b[32m+new\u001b[0m");
    expect(output.value).toContain("\u001b[36m@@ -1 +1 @@\u001b[0m");
    expect(output.value).toContain("agency | feat/terminal-ui | session session-1234");
    expect(output.value).toContain("running:executi…");
    expect(output.value).toContain("\u001b[2K");
    expect(output.value).not.toContain("provider text\u001b[2J");
    expect(output.value).toContain("provider text[2J stays text");
  });

  it("erases rich status for streamed chunks and redraws it only after message flush", () => {
    const output = new TtyBufferOutput();
    const events = new EventBus();
    const renderer = new RichTerminalRenderer(output, output, events);
    renderer.header(inspection);
    renderer.setRunStatus("running");
    events.emit({ type: "phase", phase: "executing" });
    const before = output.value.length;

    events.emit({ type: "assistant_text_delta", delta: "Hello", done: false });
    events.emit({ type: "assistant_text_delta", delta: " world", done: false });
    const during = output.value.slice(before);
    expect(during).toContain("\r\u001b[2KHello world");
    expect(during).not.toContain("Hello\n");

    events.emit({ type: "assistant_text_delta", delta: "", done: true });
    const after = output.value.slice(before);
    expect(after).toContain("Hello world\n");
    expect(after.split("\n").at(-1)).toContain("running");
  });

  it("keeps each live status row within terminal width", () => {
    const output = new TtyBufferOutput();
    const renderer = new RichTerminalRenderer(output, output);
    renderer.header({
      ...inspection,
      rootPath: "/work/a-repository-name-that-is-deliberately-far-too-long-for-one-status-row",
      currentBranch: "feat/a-branch-name-that-is-also-deliberately-too-long",
    }, {
      sessionId: "session-123456789",
      recentTurns: [],
      runSummaries: [],
    });
    renderer.setRunStatus("running");
    renderer.event({ type: "phase", phase: "executing" });

    const status = output.value.split("\n").at(-1) ?? "";
    const visible = status
      .replaceAll("\u001b[2K", "")
      .replaceAll("\u001b[2m", "")
      .replaceAll("\u001b[0m", "")
      .replaceAll("\r", "");
    expect(visible.length).toBeLessThanOrEqual(80);
    expect(visible).toContain("…");
  });

  it("keeps /status metadata at parity with plain rendering", () => {
    const output = new TtyBufferOutput();
    const renderer = new RichTerminalRenderer(output, output);
    renderer.header(inspection);
    renderer.status({
      inspection,
      session: {
        sessionId: "session-status",
        olderSummary: "older work",
        compactionCount: 2,
        lastCompactedAt: "2026-01-01T00:00:00.000Z",
        recentTurns: [{ role: "user", content: "hello" }],
        runSummaries: [{
          runId: "run-1",
          status: "completed",
          objective: "ship terminal",
          summary: "done",
          changedFiles: ["src/cli/renderer.ts"],
        }],
      },
      changedFiles: [],
    });

    expect(output.value).toContain("Last task: ship terminal");
    expect(output.value).toContain("Context: 1 recent turns, 1 recent runs, yes older summary (2 compactions)");
  });

  it("clears prior run phase when a new session resets lifecycle", () => {
    const output = new TtyBufferOutput();
    const renderer = new RichTerminalRenderer(output, output);
    renderer.header(inspection);
    renderer.setRunStatus("running");
    renderer.event({ type: "phase", phase: "executing" });
    renderer.setSession({ sessionId: "new-session", recentTurns: [], runSummaries: [] });
    renderer.setRunStatus("idle");
    renderer.message("new session ready");

    const status = output.value.split("\n").at(-1) ?? "";
    expect(status).toContain("idle");
    expect(status).not.toContain("executing");
  });

  it.each(["idle", "completed", "failed", "cancelled"] as const)(
    "clears phase when run becomes %s",
    (status) => {
      const output = new TtyBufferOutput();
      const renderer = new RichTerminalRenderer(output, output);
      renderer.header(inspection);
      renderer.setRunStatus("running");
      renderer.event({ type: "phase", phase: "executing" });
      renderer.setRunStatus(status);

      expect(output.value.split("\n").at(-1)).toContain(status);
      expect(output.value.split("\n").at(-1)).not.toContain("executing");
    },
  );

  it("strips C0 and C1 terminal controls from rich content", () => {
    const output = new TtyBufferOutput();
    const renderer = new RichTerminalRenderer(output, output);
    renderer.message("safe\u0007 bell\u0085 next\u009b31m fake");

    expect(output.value).toContain("safe bell next31m fake");
    expect(output.value).not.toContain("\u0007");
    expect(output.value).not.toContain("\u0085");
    expect(output.value).not.toContain("\u009b");
  });

  it("does not style redirected stderr", () => {
    const output = new TtyBufferOutput();
    const redirectedError = new BufferOutput();
    const renderer = new RichTerminalRenderer(output, redirectedError);
    renderer.error("boom");

    expect(redirectedError.value).toBe("Error: boom\n");
  });

  it("collapses tool activity without discarding it", () => {
    const output = new BufferOutput();
    const events = new EventBus();
    const renderer = new RichTerminalRenderer(output, output, events);
    renderer.header(inspection);

    renderer.toggleToolActivity();
    events.emit({ type: "tool", tool: "read", detail: "src/index.ts" });
    expect(output.value).not.toContain("Tool: read");

    renderer.toggleToolActivity();
    expect(output.value).toContain("Tool:");
    expect(output.value).toContain("read — src/index.ts");
  });
});

describe("terminal composer", () => {
  it("lays out flags, keycaps, and wide boundary graphemes by terminal cells", () => {
    expect(layoutTerminalText("🇮🇳1️⃣", { rows: 0, cols: 0 }, 80))
      .toEqual({ rows: 0, cols: 4 });
    expect(layoutTerminalText("界", { rows: 0, cols: 7 }, 8))
      .toEqual({ rows: 1, cols: 2 });
  });

  it("maps a real readline Ctrl+L keypress to clear listeners", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new ReadlineTerminalIO(input, output);
    const clear = vi.fn();
    io.onClear(clear);

    input.emit("keypress", "", { ctrl: true, name: "l" });
    return vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1)).finally(() => io.close());
  });

  it("redraws after native Ctrl+L handling and restores current terminal input", async () => {
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
    output.isTTY = true;
    output.columns = 80;
    let rendered = "";
    output.on("data", (chunk: Buffer) => { rendered += chunk.toString(); });
    const io = new ReadlineTerminalIO(input, output);
    io.onClear(() => { output.write("<redraw>"); });

    const reading = io.readLine("agency> ");
    input.write("draft");
    input.write("\f");
    await vi.waitFor(() => expect(rendered).toContain("<redraw>"));
    input.write("\r");
    expect(await reading).toBe("draft");
    io.close();

    const afterRedraw = rendered.slice(rendered.indexOf("<redraw>"));
    expect(afterRedraw).toContain("agency> draft");
  });

  it("restores a mid-line cursor after Ctrl+L", async () => {
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
    output.isTTY = true;
    output.columns = 80;
    let rendered = "";
    output.on("data", (chunk: Buffer) => { rendered += chunk.toString(); });
    const io = new ReadlineTerminalIO(input, output);
    io.onClear(() => { output.write("<redraw>"); });

    const reading = io.readLine("agency> ");
    input.write("draft");
    input.write("\u001b[D\u001b[D");
    input.write("\f");
    await vi.waitFor(() => expect(rendered).toContain("<redraw>"));
    input.write("X\r");

    expect(await reading).toBe("draXft");
    io.close();
    const afterRedraw = rendered.slice(rendered.indexOf("<redraw>"));
    expect(afterRedraw).toContain(`agency> draft\u001b[2D`);
  });

  it("restores cursor cells across wide and combining graphemes", async () => {
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
    output.isTTY = true;
    output.columns = 80;
    let rendered = "";
    output.on("data", (chunk: Buffer) => { rendered += chunk.toString(); });
    const io = new ReadlineTerminalIO(input, output);
    io.onClear(() => { output.write("<redraw>"); });

    const reading = io.readLine("agency> ");
    input.write("a界e\u0301z");
    input.write("\u0001\u001b[C");
    input.write("\f");
    await vi.waitFor(() => expect(rendered).toContain("<redraw>"));
    input.write("X\r");

    expect(await reading).toBe("aX界e\u0301z");
    io.close();
    const afterRedraw = rendered.slice(rendered.indexOf("<redraw>"));
    expect(afterRedraw).toContain(`agency> a界e\u0301z\u001b[4D`);
  });

  it("restores cursor cells across flag and keycap graphemes", async () => {
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
    output.isTTY = true;
    output.columns = 80;
    let rendered = "";
    output.on("data", (chunk: Buffer) => { rendered += chunk.toString(); });
    const io = new ReadlineTerminalIO(input, output);
    io.onClear(() => { output.write("<redraw>"); });

    const reading = io.readLine("agency> ");
    input.write("a🇮🇳1️⃣b");
    input.write("\u0001\u001b[C");
    input.write("\f");
    await vi.waitFor(() => expect(rendered).toContain("<redraw>"));
    input.write("X\r");

    expect(await reading).toBe("aX🇮🇳1️⃣b");
    io.close();
    const afterRedraw = rendered.slice(rendered.indexOf("<redraw>"));
    expect(afterRedraw).toContain(`agency> a🇮🇳1️⃣b\u001b[5D`);
  });

  it("restores cursor row and column for wrapped narrow-terminal input", async () => {
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
    output.isTTY = true;
    output.columns = 12;
    let rendered = "";
    output.on("data", (chunk: Buffer) => { rendered += chunk.toString(); });
    const io = new ReadlineTerminalIO(input, output);
    io.onClear(() => { output.write("<redraw>"); });

    const reading = io.readLine("agency> ");
    input.write("abcdefgh");
    input.write("\u0001\u001b[C\u001b[C");
    input.write("\f");
    await vi.waitFor(() => expect(rendered).toContain("<redraw>"));
    input.write("X\r");

    expect(await reading).toBe("abXcdefgh");
    io.close();
    const afterRedraw = rendered.slice(rendered.indexOf("<redraw>"));
    expect(afterRedraw).toContain("\u001b[1A");
    expect(afterRedraw).toContain("\u001b[6C");
  });

  it("wraps before a wide grapheme starting at the final column", async () => {
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number };
    output.isTTY = true;
    output.columns = 8;
    let rendered = "";
    output.on("data", (chunk: Buffer) => { rendered += chunk.toString(); });
    const io = new ReadlineTerminalIO(input, output);
    io.onClear(() => { output.write("<redraw>"); });

    const reading = io.readLine("p> ");
    input.write("abcd界z");
    input.write("\u0001\u001b[C\u001b[C\u001b[C\u001b[C");
    input.write("\f");
    await vi.waitFor(() => expect(rendered).toContain("<redraw>"));
    input.write("X\r");

    expect(await reading).toBe("abcdX界z");
    io.close();
    const afterRedraw = rendered.slice(rendered.indexOf("<redraw>"));
    expect(afterRedraw).toContain("\u001b[1A");
    expect(afterRedraw).toContain("\u001b[4C");
  });

  it("joins lines ending in a backslash and uses a continuation prompt", async () => {
    const prompts: string[] = [];
    const io: TerminalIO = {
      readLine: async (prompt) => {
        prompts.push(prompt);
        return ["first line \\", "second line", null][prompts.length - 1] ?? null;
      },
      onInterrupt: () => () => {},
      onClear: () => () => {},
      close: () => {},
    };
    const handler: ReplHandler = {
      handle: vi.fn(async () => "exit"),
      interruptActive: vi.fn(async () => {}),
      redraw: vi.fn(),
    };

    await new AgencyRepl(io, handler).run();

    expect(handler.handle).toHaveBeenCalledWith(
      "first line\nsecond line",
      expect.any(AbortSignal),
    );
    expect(prompts).toEqual(["agency> ", "    ... "]);
  });

  it("redraws on Ctrl+L without changing Ctrl+C semantics", async () => {
    let clear: (() => void) | undefined;
    const handler: ReplHandler = {
      handle: vi.fn(async () => "exit"),
      interruptActive: vi.fn(async () => {}),
      redraw: vi.fn(),
    };
    const io: TerminalIO = {
      readLine: async () => {
        clear?.();
        return "/exit";
      },
      onInterrupt: () => () => {},
      onClear: (listener) => {
        clear = listener;
        return () => { clear = undefined; };
      },
      close: () => {},
    };

    await new AgencyRepl(io, handler).run();
    expect(handler.redraw).toHaveBeenCalledTimes(1);
  });

  it("keeps Ctrl+D exit semantics during a continued composition", async () => {
    const io: TerminalIO = {
      readLine: vi.fn()
        .mockResolvedValueOnce("unfinished \\")
        .mockResolvedValueOnce(null),
      onInterrupt: () => () => {},
      close: () => {},
    };
    const handler: ReplHandler = {
      handle: vi.fn(async () => "continue"),
      interruptActive: vi.fn(async () => {}),
    };

    await new AgencyRepl(io, handler).run();
    expect(handler.handle).not.toHaveBeenCalled();
  });
});
