import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { InfrastructureError } from "../process/index.js";

export const MissionKindSchema = z.enum(["tests", "dead-code", "simplify", "performance"]);
export type MissionKind = z.infer<typeof MissionKindSchema>;

const RunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const CountSchema = z.number().int().nonnegative().max(1_000_000);
const DurationSchema = z.number().finite().nonnegative().max(31_536_000_000);
const MAX_DIRECTORY_ENTRIES = 1_000;
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
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new InfrastructureError("METADATA_READ_FAILED", `Evaluation directory exceeds ${MAX_DIRECTORY_ENTRIES} entries`);
    }
    const jsonEntries = entries.filter(({ name }) => name.endsWith(".json"));
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
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_EVALUATION_BYTES) {
        throw new InfrastructureError("METADATA_INVALID", "Evaluation file is not a bounded regular file");
      }
      const content = await handle.readFile("utf8");
      return RunEvaluationSchema.parse(JSON.parse(content));
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
