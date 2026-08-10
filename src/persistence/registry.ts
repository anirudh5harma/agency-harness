import { join } from "node:path";

import { z } from "zod";

import { RunStatusSchema, type RunStatus } from "../domain/index.js";
import { InfrastructureError } from "../process/infrastructure-error.js";
import { readJsonFile, writeJsonFileAtomic } from "./json-file.js";

const NonEmptyStringSchema = z.string().trim().min(1);

export const IncompleteRunStatusSchema = z.enum([
  "preparing",
  "planning",
  "executing",
  "verifying",
  "repairing",
]);
export type IncompleteRunStatus = z.infer<typeof IncompleteRunStatusSchema>;

export const IncompleteRunEntrySchema = z.strictObject({
  runId: NonEmptyStringSchema,
  threadId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  userIntent: NonEmptyStringSchema,
  status: IncompleteRunStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type IncompleteRunEntry = z.infer<typeof IncompleteRunEntrySchema>;

const IncompleteRunRegistrySchema = z.strictObject({
  runs: z.array(IncompleteRunEntrySchema).default([]),
});

const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export class IncompleteRunRegistry {
  readonly path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, ".devagency", "incomplete-runs.json");
  }

  async list(): Promise<IncompleteRunEntry[]> {
    const registry = await readJsonFile(this.path, IncompleteRunRegistrySchema);
    return registry?.runs ?? [];
  }

  async upsert(entry: IncompleteRunEntry): Promise<void> {
    let parsed: IncompleteRunEntry;
    try {
      parsed = IncompleteRunEntrySchema.parse(entry);
    } catch (cause) {
      throw new InfrastructureError(
        "METADATA_INVALID",
        "Invalid incomplete run discovery metadata",
        { cause },
      );
    }
    const runs = (await this.list()).filter(({ runId }) => runId !== parsed.runId);
    runs.push(parsed);
    await writeJsonFileAtomic(this.path, { runs });
  }

  async updateStatus(
    runId: string,
    status: RunStatus,
    updatedAt: string,
  ): Promise<void> {
    const parsedStatus = RunStatusSchema.parse(status);
    const runs = await this.list();
    const existing = runs.find((entry) => entry.runId === runId);
    if (!existing) return;

    if (TERMINAL_STATUSES.has(parsedStatus)) {
      await writeJsonFileAtomic(this.path, {
        runs: runs.filter((entry) => entry.runId !== runId),
      });
      return;
    }

    await this.upsert({
      ...existing,
      status: IncompleteRunStatusSchema.parse(parsedStatus),
      updatedAt: z.iso.datetime().parse(updatedAt),
    });
  }
}

export async function discoverIncompleteRuns(
  projectRoot: string,
): Promise<IncompleteRunEntry[]> {
  return new IncompleteRunRegistry(projectRoot).list();
}
