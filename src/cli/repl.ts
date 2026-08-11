import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface TerminalIO {
  readLine(prompt: string, options?: { signal?: AbortSignal }): Promise<string | null>;
  onInterrupt(listener: () => void): () => void;
  close(): void;
}

export class ReadlineTerminalIO implements TerminalIO {
  readonly #readline: Interface;
  #closed = false;

  constructor(input: Readable, output: Writable) {
    this.#readline = createInterface({
      input,
      output,
      terminal: Boolean((output as Writable & { isTTY?: boolean }).isTTY),
    });
    this.#readline.once("close", () => {
      this.#closed = true;
    });
  }

  async readLine(prompt: string, options: { signal?: AbortSignal } = {}): Promise<string | null> {
    if (this.#closed) return null;
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
    }
  }

  onInterrupt(listener: () => void): () => void {
    this.#readline.on("SIGINT", listener);
    return () => this.#readline.off("SIGINT", listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#readline.close();
  }
}

export interface ReplHandler {
  handle(line: string, signal: AbortSignal): Promise<"continue" | "exit">;
  interruptActive(): Promise<void>;
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
    try {
      while (!this.#exitRequested) {
        const value = await this.#io.readLine(this.#prompt);
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
    }
  }
}
