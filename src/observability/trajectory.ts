import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { InfrastructureError } from "../process/index.js";

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
  question: z.string().trim().min(1).max(1_000).optional(),
  optionLabels: z.array(z.string().trim().min(1).max(80)).min(2).max(3).optional(),
  resolution: z.string().trim().min(1).max(128).optional(),
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
  private initialization: Promise<string | undefined> | undefined;

  constructor(projectRoot: string) {
    this.runsPath = join(projectRoot, ".devagency", "runs");
  }

  pathFor(runId: string): string {
    return join(this.runsPath, `${IdentifierSchema.parse(runId)}.jsonl`);
  }

  async append(event: TrajectoryEvent): Promise<void> {
    let parsed: TrajectoryEvent;
    try {
      parsed = TrajectoryEventSchema.parse(event);
      this.initialization ??= mkdir(this.runsPath, { recursive: true });
      await this.initialization;
      await appendFile(
        this.pathFor(parsed.runId),
        `${JSON.stringify(parsed)}\n`,
        "utf8",
      );
    } catch (cause) {
      throw new InfrastructureError(
        "TRAJECTORY_WRITE_FAILED",
        `Could not append trajectory event ${event.event} for run ${event.runId}`,
        { cause },
      );
    }
  }
}
