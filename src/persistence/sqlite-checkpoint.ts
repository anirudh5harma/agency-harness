import { join } from "node:path";

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

import { InfrastructureError } from "../process/infrastructure-error.js";
import { ensurePrivateMetadataDirectory, validatePrivateMetadataFile } from "./metadata-root.js";

export interface SqliteCheckpointPersistence {
  readonly path: string;
  readonly checkpointer: BaseCheckpointSaver;
  deleteThread(threadId: string): Promise<void>;
  close(): void;
}

export async function createSqliteCheckpointPersistence(
  projectRoot: string,
): Promise<SqliteCheckpointPersistence> {
  const path = join(projectRoot, ".devagency", "state.db");
  let saver: SqliteSaver;
  try {
    await ensurePrivateMetadataDirectory(projectRoot);
    await validatePrivateMetadataFile(projectRoot, path);
    saver = SqliteSaver.fromConnString(path);
    await validatePrivateMetadataFile(projectRoot, path);
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
    async deleteThread(threadId) {
      try {
        await saver.deleteThread(threadId);
      } catch (cause) {
        throw new InfrastructureError(
          "CHECKPOINT_DELETE_FAILED",
          `Could not delete checkpoint thread ${threadId} at ${path}`,
          { cause },
        );
      }
    },
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
