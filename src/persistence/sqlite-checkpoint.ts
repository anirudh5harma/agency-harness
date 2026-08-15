import { Buffer } from "node:buffer";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { RunnableConfig } from "@langchain/core/runnables";
import {
  MemorySaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type {
  CheckpointListOptions,
  DeltaChannelHistory,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";

import { InfrastructureError } from "../process/infrastructure-error.js";
import {
  ensurePrivateMetadataDirectory,
  readPrivateMetadataFile,
  validatePrivateMetadataFile,
  writePrivateMetadataFileAtomic,
} from "./metadata-root.js";

const CHECKPOINT_FORMAT = "agency-checkpoints";
const CHECKPOINT_FORMAT_VERSION = 1;
const MAX_CHECKPOINT_FILE_BYTES = 64 * 1024 * 1024;
const SQLITE_HEADER = "SQLite format 3";

type MemoryStorage = MemorySaver["storage"];
type MemoryWrites = MemorySaver["writes"];

interface PersistedBytes {
  readonly $bytes: string;
}

interface PersistedUndefined {
  readonly $undefined: true;
}

interface PersistedCheckpointFile {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly version: typeof CHECKPOINT_FORMAT_VERSION;
  readonly storage: MemoryStorage;
  readonly writes: MemoryWrites;
}

function encodeBytes(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") } satisfies PersistedBytes;
  }
  if (value === undefined) return { $undefined: true } satisfies PersistedUndefined;
  return value;
}

function decodeBytes(_key: string, value: unknown): unknown {
  if (
    typeof value === "object"
    && value !== null
    && Object.keys(value).length === 1
    && typeof (value as Partial<PersistedBytes>).$bytes === "string"
  ) {
    return new Uint8Array(Buffer.from((value as PersistedBytes).$bytes, "base64"));
  }
  if (
    typeof value === "object"
    && value !== null
    && Object.keys(value).length === 1
    && (value as Partial<PersistedUndefined>).$undefined === true
  ) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateByteArray(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function validateStorage(value: unknown): value is MemoryStorage {
  if (!isRecord(value)) return false;
  for (const namespaces of Object.values(value)) {
    if (!isRecord(namespaces)) return false;
    for (const checkpoints of Object.values(namespaces)) {
      if (!isRecord(checkpoints)) return false;
      for (const checkpoint of Object.values(checkpoints)) {
        if (
          !Array.isArray(checkpoint)
          || checkpoint.length !== 3
          || !validateByteArray(checkpoint[0])
          || !validateByteArray(checkpoint[1])
          || (checkpoint[2] !== undefined && checkpoint[2] !== null && typeof checkpoint[2] !== "string")
        ) return false;
      }
    }
  }
  return true;
}

function validateWrites(value: unknown): value is MemoryWrites {
  if (!isRecord(value)) return false;
  for (const writes of Object.values(value)) {
    if (!isRecord(writes)) return false;
    for (const write of Object.values(writes)) {
      if (
        !Array.isArray(write)
        || write.length !== 3
        || typeof write[0] !== "string"
        || typeof write[1] !== "string"
        || !validateByteArray(write[2])
      ) return false;
    }
  }
  return true;
}

function parseCheckpointFile(contents: string): PersistedCheckpointFile {
  const parsed: unknown = JSON.parse(contents, decodeBytes);
  if (
    !isRecord(parsed)
    || parsed.format !== CHECKPOINT_FORMAT
    || parsed.version !== CHECKPOINT_FORMAT_VERSION
    || !validateStorage(parsed.storage)
    || !validateWrites(parsed.writes)
  ) {
    throw new Error("unsupported or malformed Agency checkpoint file");
  }
  const file = parsed as unknown as PersistedCheckpointFile;
  for (const namespaces of Object.values(file.storage)) {
    for (const checkpoints of Object.values(namespaces)) {
      for (const checkpoint of Object.values(checkpoints)) {
        if (checkpoint[2] === null) checkpoint[2] = undefined;
      }
    }
  }
  return file;
}

function serializedCheckpointFile(saver: MemorySaver): string {
  return JSON.stringify({
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_FORMAT_VERSION,
    storage: saver.storage,
    writes: saver.writes,
  } satisfies PersistedCheckpointFile, encodeBytes);
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

async function migrateSqliteCheckpoint(path: string): Promise<PersistedCheckpointFile> {
  // Built into every supported Node version; loaded only for one-time upgrades.
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path, { readOnly: true });
  const storage: MemoryStorage = emptyRecord();
  const writes: MemoryWrites = emptyRecord();
  try {
    const checkpoints = database.prepare(`
      SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
             checkpoint, metadata
      FROM checkpoints
    `).all() as Record<string, unknown>[];
    for (const row of checkpoints) {
      const threadId = row.thread_id;
      const namespace = row.checkpoint_ns;
      const checkpointId = row.checkpoint_id;
      if (
        typeof threadId !== "string"
        || typeof namespace !== "string"
        || typeof checkpointId !== "string"
        || !validateByteArray(row.checkpoint)
        || !validateByteArray(row.metadata)
        || (row.parent_checkpoint_id !== null && typeof row.parent_checkpoint_id !== "string")
      ) throw new Error("malformed legacy checkpoint row");
      storage[threadId] ??= emptyRecord();
      storage[threadId][namespace] ??= emptyRecord();
      storage[threadId][namespace][checkpointId] = [
        row.checkpoint,
        row.metadata,
        row.parent_checkpoint_id ?? undefined,
      ];
    }

    const legacyWrites = database.prepare(`
      SELECT thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value
      FROM writes
    `).all() as Record<string, unknown>[];
    for (const row of legacyWrites) {
      const { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: checkpointId } = row;
      const { task_id: taskId, idx, channel, value } = row;
      if (
        typeof threadId !== "string"
        || typeof namespace !== "string"
        || typeof checkpointId !== "string"
        || typeof taskId !== "string"
        || typeof idx !== "number"
        || typeof channel !== "string"
        || !validateByteArray(value)
      ) throw new Error("malformed legacy checkpoint write");
      const key = JSON.stringify([threadId, namespace, checkpointId]);
      writes[key] ??= emptyRecord();
      writes[key][`${taskId},${idx}`] = [taskId, channel, value];
    }
  } finally {
    database.close();
  }
  return { format: CHECKPOINT_FORMAT, version: CHECKPOINT_FORMAT_VERSION, storage, writes };
}

class DurableFileSaver extends MemorySaver {
  readonly #projectRoot: string;
  readonly #path: string;
  #closed = false;
  #operations: Promise<void> = Promise.resolve();

  constructor(projectRoot: string, path: string, state: PersistedCheckpointFile) {
    super();
    this.#projectRoot = projectRoot;
    this.#path = path;
    this.storage = state.storage;
    this.writes = state.writes;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("checkpoint persistence is closed");
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(() => undefined, () => undefined);
    return result;
  }

  async #persist(): Promise<void> {
    const contents = serializedCheckpointFile(this);
    if (Buffer.byteLength(contents) > MAX_CHECKPOINT_FILE_BYTES) {
      throw new Error(`checkpoint file exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes`);
    }
    await writePrivateMetadataFileAtomic(this.#projectRoot, this.#path, contents);
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      const rollback = serializedCheckpointFile(this);
      try {
        const result = await operation();
        await this.#persist();
        return result;
      } catch (cause) {
        const previous = parseCheckpointFile(rollback);
        this.storage = previous.storage;
        this.writes = previous.writes;
        throw cause;
      }
    });
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      return super.getTuple(config);
    });
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const tuples = await this.#enqueue(async () => {
      this.#assertOpen();
      const result: CheckpointTuple[] = [];
      for await (const tuple of super.list(config, options)) result.push(tuple);
      return result;
    });
    yield* tuples;
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    return this.#mutate(() => super.put(config, checkpoint, metadata));
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    return this.#mutate(() => super.putWrites(config, writes, taskId));
  }

  override async deleteThread(threadId: string): Promise<void> {
    return this.#mutate(() => super.deleteThread(threadId));
  }

  override async getDeltaChannelHistory(options: {
    config: RunnableConfig;
    channels: string[];
  }): Promise<Record<string, DeltaChannelHistory>> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      return super.getDeltaChannelHistory(options);
    });
  }

  close(): void {
    this.#closed = true;
  }
}

export interface CheckpointPersistence {
  readonly path: string;
  readonly checkpointer: BaseCheckpointSaver;
  deleteThread(threadId: string): Promise<void>;
  close(): void;
}

export async function createCheckpointPersistence(
  projectRoot: string,
): Promise<CheckpointPersistence> {
  const path = join(projectRoot, ".devagency", "state.db");
  let saver: DurableFileSaver;
  try {
    await ensurePrivateMetadataDirectory(projectRoot);
    const contents = await readPrivateMetadataFile(projectRoot, path, MAX_CHECKPOINT_FILE_BYTES);
    let state: PersistedCheckpointFile;
    let writeInitialState = false;
    if (contents === null || contents.length === 0) {
      state = {
        format: CHECKPOINT_FORMAT,
        version: CHECKPOINT_FORMAT_VERSION,
        storage: emptyRecord(),
        writes: emptyRecord(),
      };
      writeInitialState = true;
    } else if (contents.startsWith(SQLITE_HEADER)) {
      state = await migrateSqliteCheckpoint(path);
      writeInitialState = true;
    } else {
      state = parseCheckpointFile(contents);
    }
    saver = new DurableFileSaver(projectRoot, path, state);
    if (writeInitialState) {
      await writePrivateMetadataFileAtomic(projectRoot, path, serializedCheckpointFile(saver));
    }
    await validatePrivateMetadataFile(projectRoot, path);
    if (contents?.startsWith(SQLITE_HEADER) === true) {
      await Promise.all([
        rm(`${path}-wal`, { force: true }).catch(() => undefined),
        rm(`${path}-shm`, { force: true }).catch(() => undefined),
      ]);
    }
  } catch (cause) {
    throw new InfrastructureError(
      "CHECKPOINT_INITIALIZATION_FAILED",
      `Could not initialize checkpoint database at ${path}`,
      { cause },
    );
  }

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
      saver.close();
    },
  };
}

/** @deprecated Use CheckpointPersistence. Kept for API compatibility. */
export type SqliteCheckpointPersistence = CheckpointPersistence;

/** @deprecated Use createCheckpointPersistence. Kept for API compatibility. */
export const createSqliteCheckpointPersistence = createCheckpointPersistence;
