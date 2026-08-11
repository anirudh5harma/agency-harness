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
    }
  | {
      status: "terminal_checkpoint";
      terminalStatus: "completed" | "failed" | "cancelled";
      entry: IncompleteRunEntry;
      snapshot: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function checkpointValues(snapshot: unknown): Record<string, unknown> | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.values)) return null;
  return Object.keys(snapshot.values).length === 0 ? null : snapshot.values;
}

function hasPendingGraphWork(snapshot: unknown): boolean {
  if (!isRecord(snapshot)) return true;
  const next = snapshot.next;
  const tasks = snapshot.tasks;
  if (!Array.isArray(next) || !Array.isArray(tasks)) return true;
  return next.length > 0 || tasks.length > 0;
}

function terminalStatus(values: Record<string, unknown>): "completed" | "failed" | "cancelled" | null {
  return values.status === "completed" || values.status === "failed" || values.status === "cancelled"
    ? values.status
    : null;
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
        const status = terminalStatus(values);
        if (status !== null && !hasPendingGraphWork(snapshot)) {
          return {
            status: "terminal_checkpoint",
            terminalStatus: status,
            entry,
            snapshot,
          };
        }
        return { status: "resumable", entry, snapshot };
      }
      return { status: "stale_checkpoint", entry, snapshot };
    }),
  );
}
