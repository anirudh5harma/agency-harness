import { InfrastructureError } from "../process/infrastructure-error.js";
import type {
  IncompleteRunEntry,
  IncompleteRunRegistry,
} from "./registry.js";

export interface RecoveryStateReader {
  getState(threadId: string): Promise<unknown>;
}

export type IncompleteRunRecoveryInspection =
  | {
      status: "resumable";
      entry: IncompleteRunEntry;
      snapshot: unknown;
    }
  | {
      status: "stale_checkpoint";
      entry: IncompleteRunEntry;
      snapshot: unknown;
    }
  | {
      status: "missing_checkpoint";
      entry: IncompleteRunEntry;
      snapshot: null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function checkpointValues(snapshot: unknown): Record<string, unknown> | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.values)) return null;
  return Object.keys(snapshot.values).length === 0 ? null : snapshot.values;
}

export async function inspectIncompleteRunRecovery(
  registry: Pick<IncompleteRunRegistry, "list">,
  graph: RecoveryStateReader,
): Promise<IncompleteRunRecoveryInspection[]> {
  const entries = await registry.list();
  return Promise.all(
    entries.map(async (entry): Promise<IncompleteRunRecoveryInspection> => {
      let snapshot: unknown;
      try {
        snapshot = await graph.getState(entry.threadId);
      } catch (cause) {
        throw new InfrastructureError(
          "CHECKPOINT_READ_FAILED",
          `Could not inspect checkpoint for thread ${entry.threadId}`,
          { cause },
        );
      }

      const values = checkpointValues(snapshot);
      if (values === null) {
        return { status: "missing_checkpoint", entry, snapshot: null };
      }
      if (values.runId === entry.runId && values.threadId === entry.threadId) {
        return { status: "resumable", entry, snapshot };
      }
      return { status: "stale_checkpoint", entry, snapshot };
    }),
  );
}
