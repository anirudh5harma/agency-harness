import { emitKeypressEvents, moveCursor } from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

function isFullWidthCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeWidth(segment: string): number {
  const invisible = [...segment].every((character) => {
    const codePoint = character.codePointAt(0);
    return /\p{Mark}/u.test(character) || codePoint === 0x200d ||
      codePoint === 0xfe0e || codePoint === 0xfe0f;
  });
  if (invisible) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) || segment.includes("\u20e3")) {
    return 2;
  }
  return isFullWidthCodePoint(segment.codePointAt(0) ?? 0) ? 2 : 1;
}

export interface TerminalTextPosition {
  rows: number;
  cols: number;
}

export function layoutTerminalText(
  value: string,
  start: TerminalTextPosition,
  columns?: number,
): TerminalTextPosition {
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value);
  let rows = start.rows;
  let cols = start.cols;
  for (const { segment } of segments) {
    const width = graphemeWidth(segment);
    if (columns === undefined) {
      cols += width;
      continue;
    }
    if (width === 2 && cols === columns - 1) {
      rows += 1;
      cols = 0;
    }
    rows += Math.floor((cols + width) / columns);
    cols = (cols + width) % columns;
  }
  return { rows, cols };
}

export interface TerminalIO {
  readLine(prompt: string, options?: { signal?: AbortSignal }): Promise<string | null>;
  onInterrupt(listener: () => void): () => void;
  onClear?(listener: () => void): () => void;
  close(): void;
}

export class ReadlineTerminalIO implements TerminalIO {
  readonly #readline: Interface;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #clearListeners = new Set<() => void>();
  #activePrompt = "";
  #closed = false;

  constructor(input: Readable, output: Writable) {
    this.#input = input;
    this.#output = output;
    emitKeypressEvents(input);
    input.on("keypress", this.#handleKeypress);
    this.#readline = createInterface({
      input,
      output,
      terminal: Boolean((output as Writable & { isTTY?: boolean }).isTTY),
    });
    this.#readline.once("close", () => {
      this.#closed = true;
      this.#input.off("keypress", this.#handleKeypress);
    });
  }

  async readLine(prompt: string, options: { signal?: AbortSignal } = {}): Promise<string | null> {
    if (this.#closed) return null;
    this.#activePrompt = prompt;
    try {
      return await this.#readline.question(prompt, options);
    } catch (error) {
      if (
        this.#closed ||
        (error instanceof DOMException && error.name === "AbortError") ||
        (error as NodeJS.ErrnoException).code === "ABORT_ERR" ||
        (error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE"
      ) {
        return null;
      }
      throw error;
    } finally {
      this.#activePrompt = "";
    }
  }

  onInterrupt(listener: () => void): () => void {
    this.#readline.on("SIGINT", listener);
    return () => this.#readline.off("SIGINT", listener);
  }

  onClear(listener: () => void): () => void {
    this.#clearListeners.add(listener);
    return () => this.#clearListeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#input.off("keypress", this.#handleKeypress);
    this.#readline.close();
  }

  readonly #handleKeypress = (_value: string, key?: { ctrl?: boolean; name?: string }): void => {
    if (key?.ctrl !== true || key.name !== "l") return;
    const prompt = this.#activePrompt;
    const currentInput = this.#readline.line;
    const currentCursor = this.#readline.cursor;
    const cursorPosition = this.#readline.getCursorPos();
    const trailingInput = currentInput.slice(currentCursor);
    const outputColumns = (this.#output as Writable & { columns?: number }).columns;
    const columns = outputColumns !== undefined && outputColumns > 0
      ? Math.floor(outputColumns)
      : undefined;
    queueMicrotask(() => {
      if (this.#closed) return;
      for (const listener of [...this.#clearListeners]) listener();
      this.#output.write(`${prompt}${currentInput}`);
      const end = layoutTerminalText(trailingInput, cursorPosition, columns);
      if (end.rows === cursorPosition.rows && end.cols === cursorPosition.cols) return;
      moveCursor(
        this.#output,
        cursorPosition.cols - end.cols,
        cursorPosition.rows - end.rows,
      );
    });
  };
}

export interface ReplHandler {
  handle(line: string, signal: AbortSignal): Promise<"continue" | "exit">;
  interruptActive(): Promise<void>;
  beforeInput?(): void;
  redraw?(): void;
}

export class AgencyRepl {
  readonly #io: TerminalIO;
  readonly #handler: ReplHandler;
  readonly #prompt: string;
  #active: AbortController | null = null;
  #exitRequested = false;

  constructor(io: TerminalIO, handler: ReplHandler, prompt = "agency> ") {
    this.#io = io;
    this.#handler = handler;
    this.#prompt = prompt;
  }

  async run(): Promise<void> {
    const detachInterrupt = this.#io.onInterrupt(() => {
      if (this.#active === null) {
        this.#exitRequested = true;
        this.#io.close();
        return;
      }
      this.#active.abort();
      void this.#handler.interruptActive();
    });
    const detachClear = this.#io.onClear?.(() => this.#handler.redraw?.()) ?? (() => {});
    try {
      while (!this.#exitRequested) {
        this.#handler.beforeInput?.();
        const value = await this.#readComposition();
        if (value === null) break;
        const line = value.trim();
        if (line === "") continue;
        this.#active = new AbortController();
        try {
          if ((await this.#handler.handle(line, this.#active.signal)) === "exit") break;
        } finally {
          this.#active = null;
        }
      }
    } finally {
      detachInterrupt();
      detachClear();
    }
  }

  async #readComposition(): Promise<string | null> {
    const lines: string[] = [];
    let prompt = this.#prompt;
    while (true) {
      const value = await this.#io.readLine(prompt);
      if (value === null) return null;
      if (!value.endsWith("\\")) {
        lines.push(value);
        return lines.join("\n");
      }
      lines.push(value.slice(0, -1).trimEnd());
      prompt = "    ... ";
    }
  }
}
