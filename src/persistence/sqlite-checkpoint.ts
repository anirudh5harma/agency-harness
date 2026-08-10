import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

import { InfrastructureError } from "../process/infrastructure-error.js";

export interface SqliteCheckpointPersistence {
  readonly path: string;
  readonly checkpointer: BaseCheckpointSaver;
  close(): void;
}

export async function createSqliteCheckpointPersistence(
  projectRoot: string,
): Promise<SqliteCheckpointPersistence> {
  const path = join(projectRoot, ".devagency", "state.db");
  let saver: SqliteSaver;
  try {
    await mkdir(dirname(path), { recursive: true });
    saver = SqliteSaver.fromConnString(path);
  } catch (cause) {
    throw new InfrastructureError(
      "CHECKPOINT_INITIALIZATION_FAILED",
      `Could not initialize checkpoint database at ${path}`,
      { cause },
    );
  }

  let closed = false;
  return {
    path,
    checkpointer: saver,
    close() {
      if (closed) return;
      try {
        saver.db.close();
        closed = true;
      } catch (cause) {
        throw new InfrastructureError(
          "CHECKPOINT_CLOSE_FAILED",
          `Could not close checkpoint database at ${path}`,
          { cause },
        );
      }
    },
  };
}
