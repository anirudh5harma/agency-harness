import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { InfrastructureError } from "../process/index.js";

export const MissionKindSchema = z.enum(["tests", "dead-code", "simplify", "performance"]);
export type MissionKind = z.infer<typeof MissionKindSchema>;

const RunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const CountSchema = z.number().int().nonnegative().max(1_000_000);
const DurationSchema = z.number().finite().nonnegative().max(31_536_000_000);
// Valid Agency-owned records are retained by recency. Unknown and unsafe entries
// are never removed, and reads cap filesystem work even if those entries accumulate.
const MAX_RETAINED_EVALUATIONS = 1_000;
const MAX_JSON_DIRECTORY_ENTRIES = 10_000;
const MAX_EVALUATION_BYTES = 64 * 1024;
const MAX_CORRUPT_ALLOWANCE = 100;
const FILE_CONCURRENCY = 8;

export const RunEvaluationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: RunIdSchema,
  status: z.enum(["completed", "failed", "cancelled"]),
  success: z.boolean(),
  durationMs: DurationSchema,
  repairAttempts: z.number().int().nonnegative().max(20),
  toolCalls: CountSchema,
  modelCalls: z.strictObject({
    planner: CountSchema,
    execute: CountSchema,
    repair: CountSchema,
    total: CountSchema,
  }).superRefine((calls, context) => {
    if (calls.total !== calls.planner + calls.execute + calls.repair) {
      context.addIssue({ code: "custom", path: ["total"], message: "total must equal role counts" });
    }
  }),
  changedFileCount: z.number().int().nonnegative().max(2_000),
  verification: z.strictObject({
    status: z.enum(["passed", "failed", "skipped", "not-run"]),
    commandCount: z.number().int().nonnegative().max(420),
    durationsMs: z.array(DurationSchema).max(420),
  }),
  humanDecisionCount: CountSchema,
  mission: MissionKindSchema.optional(),
}).superRefine((evaluation, context) => {
  if (evaluation.verification.commandCount !== evaluation.verification.durationsMs.length) {
    context.addIssue({ code: "custom", path: ["verification", "commandCount"], message: "count must equal duration list" });
  }
});
export type RunEvaluation = z.infer<typeof RunEvaluationSchema>;

export interface RecentEvaluations {
  evaluations: RunEvaluation[];
  corruptCount: number;
}

export interface EvaluationStoreBoundary {
  write(evaluation: RunEvaluation): Promise<void>;
}

export interface EvaluationRepository extends EvaluationStoreBoundary {
  listRecent(limit?: number): Promise<RecentEvaluations>;
}

export class EvaluationStore implements EvaluationRepository {
  readonly directory: string;
  readonly #projectRoot: string;

  constructor(projectRoot: string) {
    this.#projectRoot = resolve(projectRoot);
    this.directory = join(this.#projectRoot, ".devagency", "evaluations");
  }

  async write(evaluation: RunEvaluation): Promise<void> {
    const parsed = RunEvaluationSchema.parse(evaluation);
    const directory = await this.#validatedDirectory();
    const target = join(directory, `${parsed.runId}.json`);
    const temporary = join(directory, `.${parsed.runId}.${randomUUID()}.tmp`);
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
      throw new InfrastructureError("METADATA_WRITE_FAILED", "Evaluation target must be a regular non-symlink file");
    }
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      await handle.sync();
      if (await realpath(directory) !== directory) {
        throw new InfrastructureError("METADATA_WRITE_FAILED", "Evaluation directory changed during write");
      }
      const current = await lstat(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if ((existing === undefined) !== (current === undefined) ||
        (existing !== undefined && current !== undefined &&
          (existing.dev !== current.dev || existing.ino !== current.ino || current.isSymbolicLink() || current.nlink !== 1))) {
        throw new InfrastructureError("METADATA_WRITE_FAILED", "Evaluation target changed during write");
      }
      await rename(temporary, target);
      await this.#pruneOwnedEvaluations(directory, parsed.runId);
    } catch (cause) {
      if (cause instanceof InfrastructureError) throw cause;
      throw new InfrastructureError("METADATA_WRITE_FAILED", `Could not write evaluation ${parsed.runId}`, { cause });
    } finally {
      await handle.close();
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  async listRecent(limit = 100): Promise<RecentEvaluations> {
    const boundedLimit = Math.max(0, Math.min(100, Math.floor(limit)));
    let directory: string;
    try {
      directory = await this.#validatedDirectory(false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { evaluations: [], corruptCount: 0 };
      }
      throw error;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    const jsonEntries = entries.filter(({ name }) => name.endsWith(".json"));
    if (jsonEntries.length > MAX_JSON_DIRECTORY_ENTRIES) {
      throw new InfrastructureError(
        "METADATA_READ_FAILED",
        `Evaluation directory exceeds ${MAX_JSON_DIRECTORY_ENTRIES} JSON entries`,
      );
    }
    let corruptCount = jsonEntries.filter((entry) => !entry.isFile()).length;
    const regular = jsonEntries.filter((entry) => entry.isFile());
    const dated: Array<{ name: string; modifiedAt: number }> = [];
    for (let offset = 0; offset < regular.length; offset += FILE_CONCURRENCY) {
      const batch = regular.slice(offset, offset + FILE_CONCURRENCY);
      const stats = await Promise.all(batch.map(async ({ name }) => {
        try {
          const info = await lstat(join(directory, name));
          return info.isFile() && !info.isSymbolicLink() && info.nlink === 1
            ? { name, modifiedAt: info.mtimeMs }
            : null;
        } catch {
          return null;
        }
      }));
      for (const value of stats) {
        if (value === null) corruptCount += 1;
        else dated.push(value);
      }
    }
    dated.sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name));
    const evaluations: RunEvaluation[] = [];
    const window = dated.slice(0, boundedLimit + MAX_CORRUPT_ALLOWANCE);
    for (const { name } of window) {
      try {
        const value = await this.#readEvaluation(join(directory, name));
        if (evaluations.length < boundedLimit) evaluations.push(value);
      } catch (error) {
        if (error instanceof InfrastructureError &&
          (error.code === "METADATA_INVALID" || error.code === "METADATA_READ_FAILED")) {
          corruptCount += 1;
        } else {
          throw error;
        }
      }
    }
    return { evaluations, corruptCount };
  }

  async #pruneOwnedEvaluations(directory: string, currentRunId: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    const possibleOwned = entries.filter((entry) =>
      entry.isFile() && entry.name.endsWith(".json") &&
      RunIdSchema.safeParse(entry.name.slice(0, -".json".length)).success);
    if (possibleOwned.length <= MAX_RETAINED_EVALUATIONS) return;
    const candidates: Array<{
      path: string;
      runId: string;
      modifiedAt: number;
      dev: bigint;
      ino: bigint;
    }> = [];
    for (let offset = 0; offset < possibleOwned.length; offset += FILE_CONCURRENCY) {
      const batch = possibleOwned.slice(offset, offset + FILE_CONCURRENCY);
      const validated = await Promise.all(batch.map(async (entry) => {
        const runId = entry.name.slice(0, -".json".length);
        const path = join(directory, entry.name);
        try {
          const record = await this.#readEvaluationRecord(path);
          if (record.evaluation.runId !== runId) return null;
          return { path, runId, ...record };
        } catch {
          // Corrupt or concurrently changed files are not known to be Agency-owned.
          return null;
        }
      }));
      for (const record of validated) {
        if (record === null) continue;
        const { path, runId, modifiedAt, dev, ino } = record;
        candidates.push({ path, runId, modifiedAt, dev, ino });
      }
    }
    candidates.sort((left, right) => {
      if (left.runId === currentRunId && right.runId !== currentRunId) return 1;
      if (right.runId === currentRunId && left.runId !== currentRunId) return -1;
      return left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path);
    });
    const excess = candidates.length - MAX_RETAINED_EVALUATIONS;
    for (const candidate of candidates.slice(0, Math.max(0, excess))) {
      const quarantine = join(directory, `.prune-${randomUUID()}.tmp`);
      try {
        await rename(candidate.path, quarantine);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const moved = await lstat(quarantine, { bigint: true });
      if (!moved.isFile() || moved.isSymbolicLink() || moved.nlink !== 1n ||
        moved.dev !== candidate.dev || moved.ino !== candidate.ino) {
        // Restore without overwriting a concurrently published path. If that path
        // now exists, preserve the quarantined entry rather than deleting it.
        await link(quarantine, candidate.path)
          .then(async () => unlink(quarantine))
          .catch(() => undefined);
        continue;
      }
      await unlink(quarantine);
    }
  }

  async #validatedDirectory(create = true): Promise<string> {
    const canonicalRoot = await realpath(this.#projectRoot);
    const rootInfo = await lstat(canonicalRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new InfrastructureError("METADATA_INVALID", "Evaluation project root must be a real directory");
    }
    let current = canonicalRoot;
    for (const segment of [".devagency", "evaluations"]) {
      current = join(current, segment);
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
        await mkdir(current, { mode: 0o700 }).catch((mkdirError: NodeJS.ErrnoException) => {
          if (mkdirError.code !== "EEXIST") throw mkdirError;
        });
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new InfrastructureError("METADATA_INVALID", "Evaluation metadata directories must not be symlinks");
      }
      const canonical = await realpath(current);
      const rel = relative(canonicalRoot, canonical);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new InfrastructureError("METADATA_INVALID", "Evaluation directory escapes project root");
      }
      current = canonical;
    }
    return current;
  }

  async #readEvaluation(path: string): Promise<RunEvaluation> {
    return (await this.#readEvaluationRecord(path)).evaluation;
  }

  async #readEvaluationRecord(path: string): Promise<{
    evaluation: RunEvaluation;
    modifiedAt: number;
    dev: bigint;
    ino: bigint;
  }> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_EVALUATION_BYTES)) {
        throw new InfrastructureError("METADATA_INVALID", "Evaluation file is not a bounded regular file");
      }
      const content = await handle.readFile("utf8");
      const after = await handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs) {
        throw new InfrastructureError("METADATA_READ_FAILED", "Evaluation file changed while being read");
      }
      return {
        evaluation: RunEvaluationSchema.parse(JSON.parse(content)),
        modifiedAt: Number(before.mtimeMs),
        dev: before.dev,
        ino: before.ino,
      };
    } catch (cause) {
      if (cause instanceof InfrastructureError) throw cause;
      throw new InfrastructureError("METADATA_INVALID", `Invalid evaluation metadata at ${path}`, { cause });
    } finally {
      await handle?.close();
    }
  }
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface EvaluationAggregate {
  runs: number;
  successRate: number;
  averageDurationMs: number;
  averageRepairAttempts: number;
  averageToolCalls: number;
  averageModelCalls: number;
  averageChangedFiles: number;
  verificationPassRate: number;
}

export function aggregateEvaluations(evaluations: readonly RunEvaluation[]): EvaluationAggregate {
  return {
    runs: evaluations.length,
    successRate: average(evaluations.map(({ success }) => success ? 1 : 0)),
    averageDurationMs: average(evaluations.map(({ durationMs }) => durationMs)),
    averageRepairAttempts: average(evaluations.map(({ repairAttempts }) => repairAttempts)),
    averageToolCalls: average(evaluations.map(({ toolCalls }) => toolCalls)),
    averageModelCalls: average(evaluations.map(({ modelCalls }) => modelCalls.total)),
    averageChangedFiles: average(evaluations.map(({ changedFileCount }) => changedFileCount)),
    verificationPassRate: average(evaluations.map(({ verification }) => verification.status === "passed" ? 1 : 0)),
  };
}
