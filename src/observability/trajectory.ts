import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { InfrastructureError } from "../process/index.js";
import {
  ensurePrivateMetadataDirectory,
  PRIVATE_METADATA_FILE_MODE,
} from "../persistence/metadata-root.js";

const IdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);

export const TrajectoryLifecycleEventSchema = z.enum([
  "run_started",
  "prepare_started",
  "prepare_completed",
  "prepare_failed",
  "plan_started",
  "plan_completed",
  "plan_failed",
  "execution_started",
  "execution_completed",
  "execution_failed",
  "verification_started",
  "verification_completed",
  "verification_failed",
  "verification_passed",
  "repair_started",
  "repair_completed",
  "repair_failed",
  "human_input_requested",
  "human_input_resolved",
  "run_completed",
]);
export type TrajectoryLifecycleEvent = z.infer<
  typeof TrajectoryLifecycleEventSchema
>;

export const TrajectoryMetadataSchema = z.strictObject({
  attempt: z.number().int().nonnegative().max(20).optional(),
  changedFileCount: z.number().int().nonnegative().max(2_000).optional(),
  knowledgeProposalCount: z.number().int().nonnegative().max(300).optional(),
  knowledgeCategories: z.array(z.enum(["architecture", "decision", "learning"])).max(3).optional(),
  status: z.enum(["completed", "failed", "cancelled"]).optional(),
  requestId: IdentifierSchema.optional(),
  decisionKind: z.enum(["clarification", "approval"]).optional(),
  optionCount: z.number().int().min(2).max(3).optional(),
  resolution: z.enum(["option", "custom"]).optional(),
});
export type TrajectoryMetadata = z.infer<typeof TrajectoryMetadataSchema>;

export const TrajectoryEventSchema = z.strictObject({
  timestamp: z.iso.datetime(),
  runId: IdentifierSchema,
  sessionId: IdentifierSchema,
  event: TrajectoryLifecycleEventSchema,
  durationMs: z.number().finite().nonnegative().optional(),
  metadata: TrajectoryMetadataSchema.optional(),
});
export type TrajectoryEvent = z.infer<typeof TrajectoryEventSchema>;

export interface TrajectoryWriter {
  append(event: TrajectoryEvent): Promise<void>;
}

export class JsonlTrajectoryWriter implements TrajectoryWriter {
  readonly runsPath: string;
  readonly #projectRoot: string;

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
    this.runsPath = join(projectRoot, ".devagency", "runs");
  }

  pathFor(runId: string): string {
    return join(this.runsPath, `${IdentifierSchema.parse(runId)}.jsonl`);
  }

  async append(event: TrajectoryEvent): Promise<void> {
    let parsed: TrajectoryEvent;
    try {
      parsed = TrajectoryEventSchema.parse(event);
      // Revalidate on every append: an earlier validated directory can be
      // replaced between events by another local process.
      await ensurePrivateMetadataDirectory(
        this.#projectRoot,
        this.runsPath,
      );
      const handle = await open(
        this.pathFor(parsed.runId),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        PRIVATE_METADATA_FILE_MODE,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1) {
          throw new Error("trajectory files must be single-link regular files");
        }
        if ((info.mode & 0o777) !== PRIVATE_METADATA_FILE_MODE) {
          await handle.chmod(PRIVATE_METADATA_FILE_MODE);
        }
        await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
      } finally {
        await handle.close();
      }
    } catch (cause) {
      throw new InfrastructureError(
        "TRAJECTORY_WRITE_FAILED",
        `Could not append trajectory event ${event.event} for run ${event.runId}`,
        { cause },
      );
    }
  }
}
