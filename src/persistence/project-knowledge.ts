import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ProjectKnowledgeEntrySchema, ProjectKnowledgeSchema, type ProjectKnowledge, type ProjectKnowledgeEntry } from "../domain/index.js";
import { InfrastructureError } from "../process/index.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_ENTRIES = 100;
const categories = ["architecture", "decision", "learning"] as const;
const titles = { architecture: "Architecture", decision: "Decisions", learning: "Learnings" };
const filename = (category: typeof categories[number]) => category === "architecture" ? "architecture.md" : `${category}s.md`;
const missing = (error: unknown) => error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
const key = (entry: ProjectKnowledgeEntry) => `${entry.category}:${entry.text.toLocaleLowerCase()}`;

function renderFile(category: typeof categories[number], entries: readonly ProjectKnowledgeEntry[]): string {
  const body = entries.map(({ text }) => `- ${text}`).join("\n");
  return `# ${titles[category]}\n\n${body}${body === "" ? "" : "\n"}`;
}

function renderContext(entries: readonly ProjectKnowledgeEntry[]): string {
  if (entries.length === 0) return "None.";
  return categories.map((category) => {
    const lines = entries.filter((entry) => entry.category === category).map(({ text }) => `- ${text}`);
    return lines.length === 0 ? "" : `${titles[category]}:\n${lines.join("\n")}`;
  }).filter(Boolean).join("\n\n").slice(0, 12_000);
}

function parseFile(category: typeof categories[number], path: string, contents: string): ProjectKnowledgeEntry[] {
  const normalized = contents.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (
    Buffer.byteLength(contents) > MAX_FILE_BYTES
    || contents.includes("\0")
    || normalized.includes("\r")
    || lines[0] !== `# ${titles[category]}`
    || lines[1] !== ""
  ) {
    throw new InfrastructureError("METADATA_INVALID", `Invalid project knowledge at ${path}`);
  }
  const bullets = lines.slice(2).filter((line) => line !== "");
  if (bullets.some((line) => !line.startsWith("- ")) || bullets.length > MAX_ENTRIES) {
    throw new InfrastructureError("METADATA_INVALID", `Invalid project knowledge at ${path}`);
  }
  try {
    return bullets.map((line) => ProjectKnowledgeEntrySchema.parse({ category, text: line.slice(2) }));
  } catch (cause) {
    throw new InfrastructureError("METADATA_INVALID", `Invalid project knowledge at ${path}`, { cause });
  }
}

export interface ProjectKnowledgeStoreBoundary {
  load(): Promise<ProjectKnowledge>;
  append(entries: readonly ProjectKnowledgeEntry[]): Promise<ProjectKnowledge>;
}

export interface ProjectKnowledgeStoreOptions {
  rename?: (from: string, to: string) => Promise<void>;
}

export class ProjectKnowledgeStore implements ProjectKnowledgeStoreBoundary {
  readonly directory: string;
  readonly #root: string;
  readonly #rename: (from: string, to: string) => Promise<void>;
  #appendQueue: Promise<void> = Promise.resolve();

  constructor(projectRoot: string, options: ProjectKnowledgeStoreOptions = {}) {
    this.#root = resolve(projectRoot);
    this.directory = join(this.#root, ".devagency", "knowledge");
    this.#rename = options.rename ?? rename;
    if (!this.directory.startsWith(`${this.#root}${sep}`)) throw new InfrastructureError("METADATA_INVALID", "Knowledge path is outside the repository");
  }

  async #assertContained(): Promise<void> {
    for (let current = this.directory; current.startsWith(`${this.#root}${sep}`); current = dirname(current)) {
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          const target = await realpath(current);
          if (target !== this.#root && !target.startsWith(`${this.#root}${sep}`)) throw new InfrastructureError("METADATA_INVALID", "Knowledge path escapes the repository");
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }

  async load(): Promise<ProjectKnowledge> {
    await this.#assertContained();
    const entries: ProjectKnowledgeEntry[] = [];
    for (const category of categories) {
      const path = join(this.directory, filename(category));
      try {
        if ((await lstat(path)).isSymbolicLink()) throw new InfrastructureError("METADATA_INVALID", `Project knowledge file must not be a symbolic link: ${path}`);
      } catch (error) { if (!missing(error)) throw error; }
      let contents: string;
      try { contents = await readFile(path, "utf8"); }
      catch (cause) {
        if (missing(cause)) continue;
        throw new InfrastructureError("METADATA_READ_FAILED", `Could not read project knowledge at ${path}`, { cause });
      }
      entries.push(...parseFile(category, path, contents));
    }
    const deduped = [...new Map(entries.map((entry) => [key(entry), entry])).values()];
    return ProjectKnowledgeSchema.parse({ entries: deduped, renderedContext: renderContext(deduped) });
  }

  async append(proposals: readonly ProjectKnowledgeEntry[]): Promise<ProjectKnowledge> {
    const operation = this.#appendQueue.then(() => this.#append(proposals));
    this.#appendQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #append(proposals: readonly ProjectKnowledgeEntry[]): Promise<ProjectKnowledge> {
    const current = await this.load();
    const parsed = proposals.map((entry) => ProjectKnowledgeEntrySchema.parse(entry));
    const merged = [...new Map([...current.entries, ...parsed].map((entry) => [key(entry), entry])).values()];
    if (categories.some((category) => merged.filter((entry) => entry.category === category).length > MAX_ENTRIES)) throw new InfrastructureError("METADATA_WRITE_FAILED", "Project knowledge exceeds bounded entry count");
    await this.#assertContained();
    const temporaryPaths = new Set<string>();
    const replacements: Array<{
      path: string;
      temporary: string;
      original: string | null;
    }> = [];
    const replaced: typeof replacements = [];
    try {
      await mkdir(this.directory, { recursive: true });
      for (const category of categories) {
        const path = join(this.directory, filename(category));
        try {
          if ((await lstat(path)).isSymbolicLink()) throw new InfrastructureError("METADATA_INVALID", `Project knowledge file must not be a symbolic link: ${path}`);
        } catch (error) { if (!missing(error)) throw error; }
        let original: string | null;
        try { original = await readFile(path, "utf8"); }
        catch (error) {
          if (!missing(error)) throw error;
          original = null;
        }
        const temporary = join(this.directory, `.${basename(path)}.${randomUUID()}.tmp`);
        temporaryPaths.add(temporary);
        const contents = renderFile(category, merged.filter((entry) => entry.category === category));
        await writeFile(temporary, contents, { flag: "wx" });
        const written = await readFile(temporary, "utf8");
        parseFile(category, temporary, written);
        if (written !== contents) throw new Error(`Could not validate temporary project knowledge at ${temporary}`);
        replacements.push({ path, temporary, original });
      }
      for (const replacement of replacements) {
        try {
          if ((await lstat(replacement.path)).isSymbolicLink()) throw new InfrastructureError("METADATA_INVALID", `Project knowledge file must not be a symbolic link: ${replacement.path}`);
        } catch (error) { if (!missing(error)) throw error; }
        await this.#rename(replacement.temporary, replacement.path);
        temporaryPaths.delete(replacement.temporary);
        replaced.push(replacement);
      }
    } catch (cause) {
      let rollbackCause: unknown;
      for (const replacement of replaced.reverse()) {
        try {
          if (replacement.original === null) {
            await rm(replacement.path, { force: true });
            continue;
          }
          const rollback = join(this.directory, `.${basename(replacement.path)}.${randomUUID()}.tmp`);
          temporaryPaths.add(rollback);
          await writeFile(rollback, replacement.original, { flag: "wx" });
          await this.#rename(rollback, replacement.path);
          temporaryPaths.delete(rollback);
        } catch (error) {
          rollbackCause ??= error;
        }
      }
      await Promise.all([...temporaryPaths].map((path) => rm(path, { force: true }).catch(() => undefined)));
      if (cause instanceof InfrastructureError && rollbackCause === undefined) throw cause;
      throw new InfrastructureError(
        "METADATA_WRITE_FAILED",
        rollbackCause === undefined
          ? `Could not write project knowledge at ${this.directory}`
          : `Could not write or fully roll back project knowledge at ${this.directory}`,
        { cause: rollbackCause ?? cause },
      );
    }
    return ProjectKnowledgeSchema.parse({ entries: merged, renderedContext: renderContext(merged) });
  }
}
