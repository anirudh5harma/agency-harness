import {
  constants,
  type Dirent,
  type Stats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { runCommand } from "../process/index.js";

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type ToolRole = "planner" | "executor";

export const ROLE_TOOL_POLICY = Object.freeze({
  planner: ["read", "grep", "find", "ls", "submit_plan", "request_human_input"],
  executor: [
    "read", "grep", "find", "ls", "edit", "write", "bash",
    "request_human_input", "record_project_knowledge",
  ],
} as const);

const PRIVATE_PATHS = new Set([".git", ".devagency", ".agency-worktrees"]);
const IGNORED_SEARCH_DIRECTORIES = new Set([
  "node_modules", "dist", "build", "coverage", ".next", "vendor", "target",
]);
const SAFE_GIT_COMMANDS = new Set(["diff", "log", "ls-files", "rev-parse", "show", "status"]);
const GIT_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  status: new Set(["--short", "--porcelain", "--branch", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"]),
  diff: new Set(["--cached", "--staged", "--stat", "--name-only", "--name-status", "--check", "--no-ext-diff", "--no-textconv"]),
  log: new Set(["--oneline", "--decorate", "--stat", "--name-only", "--name-status", "--no-ext-diff", "--no-textconv"]),
  show: new Set(["--stat", "--name-only", "--name-status", "--no-ext-diff", "--no-textconv"]),
  "ls-files": new Set(["--cached", "--others", "--modified", "--deleted", "--exclude-standard", "-z"]),
  "rev-parse": new Set(["--show-toplevel", "--show-prefix", "--is-inside-work-tree", "--verify", "--abbrev-ref"]),
};
const MAX_SAFE_REPLACEMENT_BYTES = 64 * 1024;
const MAX_DIRECT_READ_BYTES = 1024 * 1024;
const MAX_INTERNAL_READ_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_DEPTH = 32;
const MAX_SEARCH_FILES = 20_000;
const MAX_SEARCH_ENTRIES = 40_000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 32 * 1024 * 1024;
const activeMutationSignal = new AsyncLocalStorage<AbortSignal | undefined>();
const activeToolSignal = new AsyncLocalStorage<AbortSignal | undefined>();

export const POLICY_DISPLAY = [
  "Agency tool policy (application-enforced; not an OS sandbox)",
  `Planner: ${ROLE_TOOL_POLICY.planner.join(", ")}`,
  `Executor: ${ROLE_TOOL_POLICY.executor.join(", ")}`,
  "Containment: repository-relative paths only; outside symlinks, special files, and private control paths denied.",
  "Always blocked: shell syntax, non-verification executables/scripts, network/exfiltration, credentials/cloud/privilege commands, unsafe Git, dependency changes, migrations, and publishing.",
  "Approval required: exact one-shot action for repository-local rm, sensitive control-file edits, and large destructive replacements.",
  "Sandbox status: lexical/tool-boundary policy only. No OS or network sandbox; approved verification scripts execute opaque repository code.",
].join("\n");

export interface ToolFactoryBoundary {
  createReadTool(cwd: string, options?: Parameters<typeof createReadToolDefinition>[1]): ToolDefinition;
  createGrepTool(cwd: string, options?: Parameters<typeof createGrepToolDefinition>[1]): ToolDefinition;
  createFindTool(cwd: string, options?: Parameters<typeof createFindToolDefinition>[1]): ToolDefinition;
  createLsTool(cwd: string, options?: Parameters<typeof createLsToolDefinition>[1]): ToolDefinition;
  createEditTool(cwd: string, options?: Parameters<typeof createEditToolDefinition>[1]): ToolDefinition;
  createWriteTool(cwd: string, options?: Parameters<typeof createWriteToolDefinition>[1]): ToolDefinition;
  createBashTool(cwd: string, options?: Parameters<typeof createBashToolDefinition>[1]): ToolDefinition;
}

export const defaultToolFactoryBoundary: ToolFactoryBoundary = {
  createReadTool: (cwd, options) => createReadToolDefinition(cwd, options) as ToolDefinition,
  createGrepTool: (cwd, options) => createGrepToolDefinition(cwd, options) as ToolDefinition,
  createFindTool: (cwd, options) => createFindToolDefinition(cwd, options) as ToolDefinition,
  createLsTool: (cwd, options) => createLsToolDefinition(cwd, options) as ToolDefinition,
  createEditTool: (cwd, options) => createEditToolDefinition(cwd, options) as ToolDefinition,
  createWriteTool: (cwd, options) => createWriteToolDefinition(cwd, options) as ToolDefinition,
  createBashTool: (cwd, options) => createBashToolDefinition(cwd, options) as ToolDefinition,
};

export interface VerificationInvocation {
  command: string;
  args: readonly string[];
}

function policyError(reason: string): Error {
  return new Error(`Agency policy blocks this operation: ${reason}`);
}

function assertNotAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted === true) throw new DOMException(message, "AbortError");
}

function relativePath(input: string): string {
  if (input.includes("\0") || input.includes("\\") || isAbsolute(input)) {
    throw policyError("path must be repository-relative");
  }
  const segments = input.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw policyError("parent traversal is not allowed");
  }
  return segments.filter((segment) => segment !== "" && segment !== ".").join("/") || ".";
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertPathClass(path: string, mutation: boolean): string {
  const normalized = relativePath(path);
  const privateSegment = normalized.split("/").some((segment) => PRIVATE_PATHS.has(segment.toLowerCase()));
  if (privateSegment) {
    throw policyError(mutation ? "repository control paths cannot be changed" : "private Agency and Git data cannot be read");
  }
  if (!mutation && isCredentialPath(normalized)) {
    throw policyError("credential-like paths cannot be read");
  }
  return normalized;
}

function assertCanonicalNotPrivate(root: string, canonical: string, mutation: boolean): void {
  const rel = relative(root, canonical);
  if (rel.split(sep).some((segment) => PRIVATE_PATHS.has(segment.toLowerCase()))) {
    throw policyError(mutation ? "repository control paths cannot be changed" : "private Agency and Git data cannot be read through an alias");
  }
  if (!mutation && isCredentialPath(rel.split(sep).join("/"))) {
    throw policyError("credential-like paths cannot be read through an alias");
  }
}

async function repositoryRoot(root: string): Promise<string> {
  return realpath(root);
}

async function safeExistingPath(
  root: string,
  input: string,
  role: ToolRole,
  expected: "file" | "directory" | "either",
  knownCanonicalRoot?: string,
): Promise<string> {
  const normalized = assertPathClass(input, false);
  const canonicalRoot = knownCanonicalRoot ?? await repositoryRoot(root);
  const lexical = resolve(canonicalRoot, normalized);
  if (!isWithin(canonicalRoot, lexical)) throw policyError("path escapes repository");
  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch {
    throw policyError("path does not exist");
  }
  if (!isWithin(canonicalRoot, canonical)) throw policyError("symlink resolves outside repository");
  assertCanonicalNotPrivate(canonicalRoot, canonical, false);
  const info = await stat(canonical);
  if (info.isFile() && info.nlink !== 1) throw policyError("hard-linked files are not allowed");
  if (expected === "file" && !info.isFile()) throw policyError("read target must be a regular file");
  if (expected === "directory" && !info.isDirectory()) throw policyError("target must be a directory");
  if (expected === "either" && !info.isFile() && !info.isDirectory()) {
    throw policyError("special files are not allowed");
  }
  return canonical;
}

async function safeMutationPath(root: string, input: string): Promise<string> {
  const normalized = assertPathClass(input, true);
  const canonicalRoot = await repositoryRoot(root);
  const lexical = resolve(canonicalRoot, normalized);
  if (!isWithin(canonicalRoot, lexical) || lexical === canonicalRoot) {
    throw policyError("mutation target must stay inside repository");
  }
  const rel = relative(canonicalRoot, lexical);
  let cursor = canonicalRoot;
  for (const segment of rel.split(sep).slice(0, -1)) {
    cursor = resolve(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw policyError("symlink parents are not allowed for mutation");
      if (!info.isDirectory()) throw policyError("mutation parent is not a directory");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Agency policy")) throw error;
      break;
    }
  }
  try {
    const leaf = await lstat(lexical);
    if (leaf.isSymbolicLink() || !leaf.isFile()) throw policyError("mutation target must be a regular non-symlink file");
    if (leaf.nlink !== 1) throw policyError("hard-linked mutation targets are not allowed");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Agency policy")) throw error;
  }
  return lexical;
}

async function safeReadFile(
  root: string,
  input: string,
  role: ToolRole,
  options: { signal?: AbortSignal; maxBytes?: number; canonicalRoot?: string } = {},
): Promise<Buffer> {
  const signal = options.signal ?? activeToolSignal.getStore();
  const maxBytes = options.maxBytes ?? MAX_INTERNAL_READ_BYTES;
  assertNotAborted(signal, "File read aborted");
  const path = await safeExistingPath(root, input, role, "file", options.canonicalRoot);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw policyError("read target must be a regular file");
    if (info.nlink !== 1) throw policyError("hard-linked files are not allowed");
    if (info.size > maxBytes) {
      throw policyError(`read target exceeds ${maxBytes} byte limit`);
    }
    assertNotAborted(signal, "File read aborted");
    const contents = await handle.readFile();
    assertNotAborted(signal, "File read aborted");
    return contents;
  } finally {
    await handle.close();
  }
}

async function safeMkdir(root: string, directory: string): Promise<void> {
  const canonicalRoot = await repositoryRoot(root);
  const lexicalRoot = resolve(root);
  const lexicalDirectory = resolve(directory);
  const sourceRoot = isWithin(canonicalRoot, lexicalDirectory)
    ? canonicalRoot
    : isWithin(lexicalRoot, lexicalDirectory) ? lexicalRoot : undefined;
  if (sourceRoot === undefined) throw policyError("directory escapes repository");
  const rel = relative(sourceRoot, lexicalDirectory);
  let cursor = canonicalRoot;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw policyError("write parent must be a real directory");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Agency policy")) throw error;
      await mkdir(cursor);
    }
  }
}

async function safeWriteFile(root: string, input: string, content: string): Promise<void> {
  const path = await safeMutationPath(root, input);
  const parent = dirname(path);
  await safeMkdir(root, parent);
  const canonicalRoot = await repositoryRoot(root);
  const canonicalParent = await realpath(parent);
  if (!isWithin(canonicalRoot, canonicalParent)) throw policyError("write parent escapes repository");
  assertCanonicalNotPrivate(canonicalRoot, canonicalParent, true);
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (before !== undefined && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) {
    throw policyError("write target must be a single-link regular file");
  }
  const temporary = resolve(canonicalParent, `.agency-write-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, before?.mode ?? 0o666);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw policyError("temporary write target must be a single-link regular file");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    if (activeMutationSignal.getStore()?.aborted === true) throw new DOMException("File mutation aborted", "AbortError");
    if (await realpath(parent) !== canonicalParent) throw policyError("write parent changed during mutation");
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if ((before === undefined) !== (current === undefined) ||
      (before !== undefined && current !== undefined && (before.dev !== current.dev || before.ino !== current.ino || current.nlink !== 1 || current.isSymbolicLink()))) {
      throw policyError("write target changed during mutation");
    }
    await rename(temporary, path);
  } finally {
    await handle.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

function parameterPath(params: unknown): string {
  if (typeof params !== "object" || params === null) throw policyError("missing path");
  const path = (params as Record<string, unknown>).path;
  if (path === undefined) return ".";
  if (typeof path !== "string" || path.trim() === "") throw policyError("invalid path");
  return path;
}

function assertSearchDoesNotTargetPrivate(params: unknown, includePattern: boolean): void {
  if (typeof params !== "object" || params === null) return;
  for (const key of includePattern ? ["pattern", "glob"] as const : ["glob"] as const) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === "string" && [...PRIVATE_PATHS].some((name) => value.toLowerCase().includes(name))) {
      throw policyError("private Agency and Git data cannot be searched");
    }
  }
}

interface SearchFile { path: string; size: number }

async function safeSearchFiles(
  root: string,
  input: string,
  role: ToolRole,
  signal?: AbortSignal,
): Promise<{ canonicalRoot: string; searchRoot: string; files: SearchFile[] }> {
  assertNotAborted(signal, "Search aborted");
  const canonicalRoot = await repositoryRoot(root);
  const searchRoot = await safeExistingPath(root, input, role, "either", canonicalRoot);
  const rootInfo = await lstat(searchRoot);
  if (rootInfo.isFile()) return { canonicalRoot, searchRoot: dirname(searchRoot), files: [{ path: searchRoot, size: rootInfo.size }] };
  const relativeSearchRoot = relative(canonicalRoot, searchRoot).split(sep).join("/");
  const listed = await runCommand({
    command: "git",
    args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", relativeSearchRoot === "" ? "." : relativeSearchRoot],
    cwd: canonicalRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 8 * 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  if (listed.exitCode !== 0) throw policyError("could not enumerate Git-visible search files");
  const files: SearchFile[] = [];
  const candidates = listed.stdout.split("\0").filter(Boolean).sort();
  if (candidates.length > MAX_SEARCH_ENTRIES) throw policyError(`search entry limit is ${MAX_SEARCH_ENTRIES}`);
  for (const candidate of candidates) {
    assertNotAborted(signal, "Search aborted");
    const normalized = candidate.split("/");
    if (normalized.length > MAX_SEARCH_DEPTH) throw policyError(`search depth limit is ${MAX_SEARCH_DEPTH}`);
    if (normalized.some((segment) =>
      PRIVATE_PATHS.has(segment.toLowerCase()) || IGNORED_SEARCH_DIRECTORIES.has(segment.toLowerCase())) ||
      isCredentialPath(candidate)) continue;
    const lexicalPath = resolve(canonicalRoot, candidate);
    const lexicalInfo = await lstat(lexicalPath);
    // Search never follows aliases. Direct reads report a policy error, while
    // repository-wide discovery omits links so a single unrelated alias cannot
    // make every safe search unusable.
    if (lexicalInfo.isSymbolicLink()) continue;
    if (!lexicalInfo.isFile()) throw policyError("search trees can contain only regular files");
    const path = await safeExistingPath(root, candidate, role, "file", canonicalRoot);
    if (!path.startsWith(`${searchRoot}${sep}`)) continue;
    const info = await lstat(path);
    if (files.length >= MAX_SEARCH_FILES) throw policyError(`search file limit is ${MAX_SEARCH_FILES}`);
    files.push({ path, size: info.size });
  }
  return { canonicalRoot, searchRoot, files };
}

function finiteInteger(value: unknown, fallback: number, label: string, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw policyError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function safeGrepTool(delegate: ToolDefinition, root: string, role: ToolRole): ToolDefinition {
  const parameters = delegate.parameters as unknown as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  return {
    ...delegate,
    description: "Search file contents for a literal string. Set literal to true. Regular expressions are not supported.",
    promptSnippet: "Search file contents for literal strings (literal must be true)",
    parameters: {
      ...parameters,
      required: [...new Set([...(parameters.required ?? []), "literal"])],
      properties: {
        ...(parameters.properties ?? {}),
        pattern: { type: "string", description: "Literal string to search for" },
        literal: { type: "boolean", const: true, description: "Must be true; regex search is disabled" },
      },
    } as never,
    async execute(_toolCallId, params, signal) {
      assertNotAborted(signal, "Grep aborted");
      if (typeof params !== "object" || params === null) throw policyError("invalid grep parameters");
      const raw = params as Record<string, unknown>;
      if (typeof raw.pattern !== "string" || (raw.glob !== undefined && typeof raw.glob !== "string") ||
        (raw.ignoreCase !== undefined && typeof raw.ignoreCase !== "boolean") || (raw.literal !== undefined && typeof raw.literal !== "boolean")) {
        throw policyError("invalid grep parameters");
      }
      if (raw.literal !== true) throw policyError("grep requires literal: true; regular expressions are not supported");
      assertSearchDoesNotTargetPrivate(params, false);
      const context = finiteInteger(raw.context, 0, "grep context", 0, 100);
      const limit = finiteInteger(raw.limit, 100, "grep limit", 1, 10_000);
      const { canonicalRoot, searchRoot, files } = await safeSearchFiles(root, parameterPath(params), role, signal);
      const literalPattern = raw.ignoreCase === true ? raw.pattern.toLowerCase() : raw.pattern;
      const output: string[] = [];
      let matches = 0;
      let searchedBytes = 0;
      let searchByteLimitReached = false;
      for (const file of files) {
        assertNotAborted(signal, "Grep aborted");
        const rel = relative(searchRoot, file.path).split(sep).join("/") || file.path.slice(file.path.lastIndexOf(sep) + 1);
        if (typeof raw.glob === "string" && !matchesGlob(rel, raw.glob)) continue;
        if (file.size > MAX_SEARCH_FILE_BYTES) continue;
        if (searchedBytes + file.size > MAX_SEARCH_TOTAL_BYTES) {
          searchByteLimitReached = true;
          break;
        }
        searchedBytes += file.size;
        const lines = (await safeReadFile(root, relative(canonicalRoot, file.path), role, {
          ...(signal === undefined ? {} : { signal }),
          maxBytes: MAX_SEARCH_FILE_BYTES,
          canonicalRoot,
        })).toString("utf8").replace(/\r\n?/gu, "\n").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          assertNotAborted(signal, "Grep aborted");
          const candidate = raw.ignoreCase === true ? lines[index]!.toLowerCase() : lines[index]!;
          if (!candidate.includes(literalPattern)) continue;
          matches += 1;
          const start = Math.max(0, index - context);
          const end = Math.min(lines.length - 1, index + context);
          for (let line = start; line <= end; line += 1) output.push(`${rel}${line === index ? ":" : "-"}${line + 1}${line === index ? ":" : "-"} ${lines[line]!.slice(0, 2_000)}`);
          if (matches >= limit) break;
        }
        if (matches >= limit) break;
      }
      const details = {
        ...(matches >= limit ? { matchLimitReached: limit } : {}),
        ...(searchByteLimitReached ? { searchByteLimitReached: MAX_SEARCH_TOTAL_BYTES } : {}),
      };
      return {
        content: [{ type: "text", text: output.length === 0 ? "No matches found" : output.join("\n").slice(0, 256 * 1024) }],
        details: Object.keys(details).length === 0 ? undefined : details,
      };
    },
  };
}

function safeFindTool(delegate: ToolDefinition, root: string, role: ToolRole): ToolDefinition {
  return {
    ...delegate,
    async execute(_toolCallId, params, signal) {
      assertNotAborted(signal, "Find aborted");
      if (typeof params !== "object" || params === null) throw policyError("invalid find parameters");
      const raw = params as Record<string, unknown>;
      if (typeof raw.pattern !== "string") throw policyError("find requires a glob pattern");
      assertSearchDoesNotTargetPrivate(params, true);
      const limit = finiteInteger(raw.limit, 1_000, "find limit", 1, 100_000);
      const { searchRoot, files } = await safeSearchFiles(root, parameterPath(params), role, signal);
      const results = files.map((file) => relative(searchRoot, file.path).split(sep).join("/"))
        .filter((path) => matchesGlob(path, raw.pattern as string)).slice(0, limit);
      return {
        content: [{ type: "text", text: results.length === 0 ? "No files found matching pattern" : results.join("\n").slice(0, 256 * 1024) }],
        details: results.length >= limit ? { resultLimitReached: limit } : undefined,
      };
    },
  };
}

function wrap(delegate: ToolDefinition, validate: (params: unknown, signal?: AbortSignal) => Promise<void>): ToolDefinition {
  return {
    ...delegate,
    async execute(toolCallId, params, signal, onUpdate, context) {
      assertNotAborted(signal, "Tool call aborted");
      await validate(params, signal);
      assertNotAborted(signal, "Tool call aborted");
      return activeToolSignal.run(signal, () =>
        activeMutationSignal.run(signal, () => delegate.execute(toolCallId, params, signal, onUpdate, context)));
    },
  };
}

export class MissionMutationBudget {
  readonly paths = new Set<string>();
  maxDistinctPaths: number | undefined;
  #tail: Promise<void> = Promise.resolve();

  reconcile(maxDistinctPaths: number | undefined, paths: readonly string[]): void {
    this.maxDistinctPaths = maxDistinctPaths;
    if (maxDistinctPaths === undefined) this.paths.clear();
    else for (const path of paths) this.paths.add(relativePath(path));
  }

  async run<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const normalized = relativePath(path);
    const newlyReserved = !this.paths.has(normalized);
    try {
      if (newlyReserved && this.maxDistinctPaths !== undefined && this.paths.size >= this.maxDistinctPaths) {
        throw policyError(`mission mutation budget is limited to ${this.maxDistinctPaths} distinct paths`);
      }
      if (newlyReserved) this.paths.add(normalized);
      try {
        return await operation();
      } catch (error) {
        if (newlyReserved) this.paths.delete(normalized);
        throw error;
      }
    } finally {
      release();
    }
  }
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  const finish = () => { if (word !== "") words.push(word); word = ""; };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\\") throw policyError("shell escapes are not supported");
    if (character === "'" || character === '"') {
      if (quote === undefined) quote = character;
      else if (quote === character) quote = undefined;
      else word += character;
      continue;
    }
    if (/\s/u.test(character) && quote === undefined) { finish(); continue; }
    word += character;
  }
  if (quote !== undefined) throw policyError("unbalanced shell quote");
  finish();
  return words;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function bashApprovalAction(argv: readonly string[]): string {
  return `bash:${argv[0] ?? "command"} argv:${argv.map(shellQuote).join(" ")} sha256:${digest(argv)}`;
}

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`;
}

function assertSafeGit(words: readonly string[]): string[] {
  if (words[0] !== "git") throw policyError("Git executable path and aliases are not allowed");
  const subcommand = words[1]?.toLowerCase();
  if (subcommand === undefined || !SAFE_GIT_COMMANDS.has(subcommand)) throw policyError("only enumerated read-only Git subcommands are allowed");
  const allowedOptions = GIT_OPTIONS[subcommand] ?? new Set<string>();
  let afterSeparator = false;
  const contentCommand = ["diff", "log", "show"].includes(subcommand);
  const pathArguments: string[] = [];
  for (const argument of words.slice(2)) {
    if (argument === "--") {
      if (afterSeparator) throw policyError("Git accepts exactly one path separator");
      afterSeparator = true;
      continue;
    }
    if (!afterSeparator && argument.startsWith("-")) {
      if (!allowedOptions.has(argument)) throw policyError(`Git option is not allowed for ${subcommand}`);
      continue;
    }
    if (!/^[A-Za-z0-9_./:@+~-]+$/u.test(argument) || argument.startsWith("/") || argument === ".." || argument.includes("../")) {
      throw policyError("Git revision and path arguments must be repository-local literals");
    }
    if ([...PRIVATE_PATHS].some((name) => argument.toLowerCase().includes(name))) {
      throw policyError("Git cannot inspect private Agency control paths");
    }
    const pathCandidate = argument.includes(":") ? argument.slice(argument.lastIndexOf(":") + 1) : argument;
    if (isCredentialPath(pathCandidate)) throw policyError("Git cannot inspect credential-like paths");
    if (afterSeparator) pathArguments.push(argument);
  }
  if (contentCommand && (!afterSeparator || pathArguments.length === 0)) {
    throw policyError(`${subcommand} requires -- followed by one or more exact repository file paths`);
  }
  if (contentCommand && pathArguments.some((path) => path === "." || path.endsWith("/") || /[*?[\]{}]/u.test(path))) {
    throw policyError("Git content paths must be exact file literals, not directories or wildcards");
  }
  const hardened = [...words];
  if (["diff", "log", "show"].includes(subcommand)) {
    if (!hardened.includes("--no-ext-diff")) hardened.splice(2, 0, "--no-ext-diff");
    if (!hardened.includes("--no-textconv")) hardened.splice(3, 0, "--no-textconv");
  }
  return hardened;
}

function prepareAllowedBash(
  command: string,
  consumeApproval: (action: string) => boolean,
  verificationCommands: readonly VerificationInvocation[],
): string {
  if (command.trim() === "") throw policyError("empty shell command");
  if (/[(){};|&<>\n\r`$*?!]/u.test(command) || command.includes("[") || command.includes("]")) {
    throw policyError("shell operators, expansion, redirection, and glob syntax are not supported");
  }
  const words = shellWords(command);
  if (words.length === 0 || words.some((word) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word))) {
    throw policyError("environment assignments are not supported");
  }
  if (words[0] === "git") return assertSafeGit(words).map(shellQuote).join(" ");

  const exactVerification = verificationCommands.some(({ command: executable, args }) =>
    words.length === args.length + 1 && words[0] === executable && args.every((argument, index) => words[index + 1] === argument));
  if (exactVerification) return words.map(shellQuote).join(" ");

  if (words[0] === "rm") {
    const paths = words.slice(1).filter((argument) => !argument.startsWith("-"));
    const options = words.slice(1).filter((argument) => argument.startsWith("-"));
    if (paths.length === 0 || options.some((option) => !["-r", "-f", "-rf", "-fr", "--recursive", "--force"].includes(option))) {
      throw policyError("rm requires explicit literal repository paths and known options");
    }
    for (const path of paths) assertPathClass(path, true);
    const action = bashApprovalAction(words);
    if (!consumeApproval(action)) {
      throw new Error(`Agency policy requires request_human_input explicit one-shot approval for exact action: ${action}`);
    }
    return words.map(shellQuote).join(" ");
  }
  throw policyError("executable and argv are not on Agency's exact allowlist");
}

async function assertSafeRmTargets(root: string, command: string): Promise<void> {
  const words = shellWords(command);
  if (words[0] !== "rm") return;
  const canonicalRoot = await repositoryRoot(root);
  for (const input of words.slice(1).filter((argument) => !argument.startsWith("-"))) {
    const normalized = assertPathClass(input, true);
    const target = resolve(canonicalRoot, normalized);
    if (!isWithin(canonicalRoot, target) || target === canonicalRoot) {
      throw policyError("rm target must stay inside repository");
    }
    let cursor = canonicalRoot;
    const segments = relative(canonicalRoot, target).split(sep);
    for (const [index, segment] of segments.entries()) {
      cursor = resolve(cursor, segment);
      let info;
      try {
        info = await lstat(cursor);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") break;
        throw cause;
      }
      if (info.isSymbolicLink()) throw policyError("rm cannot traverse or delete symlinks");
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw policyError("rm parent must be a real directory");
      }
      if (index === segments.length - 1 && info.isFile() && info.nlink !== 1) {
        throw policyError("rm cannot delete hard-linked files");
      }
    }
    try {
      const canonical = await realpath(target);
      if (!isWithin(canonicalRoot, canonical)) throw policyError("rm target resolves outside repository");
      assertCanonicalNotPrivate(canonicalRoot, canonical, true);
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("Agency policy")) throw cause;
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
}

async function assertSafeGitTargets(root: string, command: string): Promise<void> {
  const words = shellWords(command);
  if (words[0] !== "git") return;
  const subcommand = words[1]?.toLowerCase();
  if (subcommand === undefined || !["diff", "log", "show"].includes(subcommand)) return;
  assertSafeGit(words);
  const separator = words.indexOf("--");
  for (const path of words.slice(separator + 1)) {
    await safeExistingPath(root, path, "executor", "file");
  }
}

export function assertAllowedBash(
  command: string,
  consumeApproval: (action: string) => boolean,
  verificationCommands: readonly VerificationInvocation[] = [],
): void {
  prepareAllowedBash(command, consumeApproval, verificationCommands);
}

function isSensitivePath(path: string): boolean {
  const normalized = relativePath(path).toLowerCase();
  const name = normalized.split("/").at(-1) ?? "";
  return name === "package.json" || /^(?:package-lock|npm-shrinkwrap|pnpm-lock|yarn\.lock|bun\.lockb?)$/u.test(name) ||
    normalized.startsWith(".github/") || normalized.includes("/migrations/") || normalized.startsWith("migrations/") ||
    /(?:^|\/)(?:ci|deploy)(?:\/|$)/u.test(normalized) ||
    isCredentialPath(normalized);
}

function isCredentialPath(path: string): boolean {
  const normalized = path.toLowerCase();
  const name = normalized.split("/").at(-1) ?? "";
  const segments = normalized.split("/");
  return /^\.env(?:\..*)?$/u.test(name) || name === ".envrc" ||
    (segments.includes(".docker") && name === "config.json") ||
    /^(?:\.npmrc|\.yarnrc\.yml|\.pypirc|\.netrc|\.git-credentials|auth\.json|kubeconfig)$/u.test(name) ||
    /^(?:application_default_credentials|client_secret_.+|token|serviceaccountkey)\.json$/u.test(name) ||
    /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)$/u.test(name) ||
    /(?:^|[._-])service[._-]?account(?:[._-].*)?\.json$/u.test(name) ||
    /\.tfvars(?:\.json)?$/u.test(name) ||
    /^(?:credentials?|secrets?)(?:\..*)?$/u.test(name) ||
    /\.(?:pem|key|p12|pfx)$/u.test(name);
}

async function mutationNeedsApproval(root: string, params: unknown, tool: "edit" | "write"): Promise<string | undefined> {
  const path = parameterPath(params);
  if (typeof params !== "object" || params === null) throw policyError(`invalid ${tool} parameters`);
  const normalizedPath = relativePath(path);
  let canonical: unknown;
  if (tool === "edit") {
    const edits = (params as { edits?: Array<{ oldText?: unknown; newText?: unknown }> }).edits ?? [];
    if (!Array.isArray(edits) || edits.length === 0 || edits.some(({ oldText, newText }) => typeof oldText !== "string" || typeof newText !== "string")) {
      throw policyError("edit requires non-empty string replacement pairs");
    }
    canonical = { path: normalizedPath, edits };
    if (!isSensitivePath(path) && !edits.some(({ oldText, newText }) => typeof oldText === "string" &&
      (oldText.length > MAX_SAFE_REPLACEMENT_BYTES || (typeof newText === "string" && oldText.length > 4096 && newText.length * 4 < oldText.length)))) return undefined;
  } else {
    const content = (params as { content?: unknown }).content;
    if (typeof content !== "string") throw policyError("write requires string content");
    canonical = { path: normalizedPath, contentSha256: digest(content) };
    try {
      const old = await safeReadFile(root, path, "executor");
      if (!isSensitivePath(path) && old.length <= MAX_SAFE_REPLACEMENT_BYTES && !(old.length > 4096 && content.length * 4 < old.length)) return undefined;
    } catch (error) {
      if (error instanceof Error && error.message.includes("does not exist")) {
        if (!isSensitivePath(path)) return undefined;
      } else throw error;
    }
  }
  return `${tool}:${normalizedPath} sha256:${digest(canonical)}`;
}

export function createRoleFileTools(options: {
  root: string;
  role: ToolRole;
  factories?: ToolFactoryBoundary;
  consumeApproval?: (action: string) => boolean;
  mutationBudget?: MissionMutationBudget;
}): ToolDefinition[] {
  const { root, role } = options;
  const factories = options.factories ?? defaultToolFactoryBoundary;
  const consumeApproval = options.consumeApproval ?? (() => false);
  const readTool = wrap(factories.createReadTool(root, {
    operations: {
      readFile: (path) => safeReadFile(root, relative(root, path), role, { maxBytes: MAX_DIRECT_READ_BYTES }),
      access: async (path) => { await safeExistingPath(root, relative(root, path), role, "file"); },
    },
  }), async (params) => { await safeExistingPath(root, parameterPath(params), role, "file"); });
  const grepTool = safeGrepTool(factories.createGrepTool(root), root, role);
  const findTool = safeFindTool(factories.createFindTool(root), root, role);
  const lsTool = wrap(factories.createLsTool(root, {
    operations: {
      exists: async (path) => { try { await safeExistingPath(root, relative(root, path), role, "either"); return true; } catch { return false; } },
      stat: async (path): Promise<Stats> => stat(await safeAbsolute(root, path, role)),
      readdir: async (path) => readdir(await safeAbsolute(root, path, role), { withFileTypes: true }).then((items: Dirent[]) =>
        items.map(({ name }) => name).filter((name) => !PRIVATE_PATHS.has(name.toLowerCase()) && !isCredentialPath(name))),
    },
  }), async (params) => { await safeExistingPath(root, parameterPath(params), role, "directory"); });
  if (role === "planner") return [readTool, grepTool, findTool, lsTool];

  const approveMutation = async (params: unknown, tool: "edit" | "write", signal?: AbortSignal) => {
    const mutationPath = parameterPath(params);
    if (isCredentialPath(mutationPath)) {
      throw policyError("credential-like paths cannot be changed by model tools");
    }
    await safeMutationPath(root, mutationPath);
    const approval = await mutationNeedsApproval(root, params, tool);
    if (signal?.aborted === true) throw new DOMException("File mutation aborted", "AbortError");
    if (approval !== undefined && !consumeApproval(approval)) {
      throw new Error(`Agency policy requires request_human_input explicit one-shot approval for exact action: ${approval}`);
    }
  };
  const editDelegate = factories.createEditTool(root, {
    operations: {
      readFile: (path) => safeReadFile(root, relative(root, path), "executor"),
      writeFile: (path, content) => safeWriteFile(root, relative(root, path), content),
      access: async (path) => { await safeExistingPath(root, relative(root, path), "executor", "file"); },
    },
  });
  const writeDelegate = factories.createWriteTool(root, {
    operations: {
      writeFile: (path, content) => safeWriteFile(root, relative(root, path), content),
      mkdir: (path) => safeMkdir(root, path),
    },
  });
  const mutationTool = (delegate: ToolDefinition, tool: "edit" | "write"): ToolDefinition => ({
    ...delegate,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const run = async () => {
        assertNotAborted(signal, "Tool call aborted");
        await approveMutation(params, tool, signal);
        assertNotAborted(signal, "Tool call aborted");
        return activeMutationSignal.run(signal, () => delegate.execute(toolCallId, params, signal, onUpdate, context));
      };
      return options.mutationBudget === undefined
        ? run()
        : options.mutationBudget.run(parameterPath(params), run);
    },
  });
  const editTool = mutationTool(editDelegate, "edit");
  const writeTool = mutationTool(writeDelegate, "write");
  return [readTool, grepTool, findTool, lsTool, editTool, writeTool];
}

async function safeAbsolute(root: string, absolute: string, role: ToolRole): Promise<string> {
  return safeExistingPath(root, relative(root, absolute), role, "either");
}

export function createProtectedBashTool(options: {
  root: string;
  factories?: ToolFactoryBoundary;
  consumeApproval?: (action: string) => boolean;
  verificationCommands?: readonly VerificationInvocation[];
}): ToolDefinition {
  const delegate = (options.factories ?? defaultToolFactoryBoundary).createBashTool(options.root, {
    exposeSessionEnvironment: false,
    spawnHook: ({ command }) => ({
      command,
      cwd: options.root,
      env: {
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        CI: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CEILING_DIRECTORIES: options.root,
        GIT_CONFIG_COUNT: "4",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
        GIT_CONFIG_KEY_1: "core.fsmonitor",
        GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "diff.external",
        GIT_CONFIG_VALUE_2: "",
        GIT_CONFIG_KEY_3: "core.pager",
        GIT_CONFIG_VALUE_3: "cat",
      },
    }),
  });
  return {
    ...delegate,
    async execute(toolCallId, params, signal, onUpdate, context) {
      assertNotAborted(signal, "Bash call aborted");
      if (typeof params !== "object" || params === null || typeof (params as { command?: unknown }).command !== "string") {
        throw policyError("missing shell command");
      }
      const timeout = (params as { timeout?: unknown }).timeout;
      if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483.647)) {
        throw policyError("bash timeout must be a finite positive number no greater than 2147483.647 seconds");
      }
      await assertSafeGitTargets(options.root, (params as { command: string }).command);
      await assertSafeRmTargets(options.root, (params as { command: string }).command);
      const command = prepareAllowedBash(
        (params as { command: string }).command,
        options.consumeApproval ?? (() => false),
        options.verificationCommands ?? [],
      );
      assertNotAborted(signal, "Bash call aborted");
      return delegate.execute(toolCallId, { ...(params as object), command }, signal, onUpdate, context);
    },
  };
}
