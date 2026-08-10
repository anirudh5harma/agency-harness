import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import {
  MAX_SESSION_RUN_SUMMARIES,
  MAX_SESSION_TURNS,
  RunSummarySchema,
  SessionContextSchema,
  type RunSummary,
  type SessionContext,
} from "../domain/index.js";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/json-file.js";

const PersistedSessionSchema = SessionContextSchema.extend({
  sessionId: z.uuid(),
});

export class SessionStore {
  readonly path: string;

  constructor(private readonly projectRoot: string) {
    this.path = join(projectRoot, ".devagency", "session.json");
  }

  async loadOrCreate(): Promise<SessionContext> {
    const session = await readJsonFile(this.path, PersistedSessionSchema);
    return session ?? this.createNew();
  }

  async createNew(): Promise<SessionContext> {
    const session = SessionContextSchema.parse({ sessionId: randomUUID() });
    await writeJsonFileAtomic(this.path, session);
    return session;
  }

  async recordUserTurn(content: string): Promise<SessionContext> {
    const session = await this.loadOrCreate();
    const turn = { role: "user" as const, content };
    const updated = SessionContextSchema.parse({
      ...session,
      recentTurns: [...session.recentTurns, turn].slice(-MAX_SESSION_TURNS),
    });
    await writeJsonFileAtomic(this.path, updated);
    return updated;
  }

  async recordRunSummary(summary: RunSummary): Promise<SessionContext> {
    const session = await this.loadOrCreate();
    const parsedSummary = RunSummarySchema.parse(summary);
    if (!(["completed", "failed"] as const).includes(parsedSummary.status as never)) {
      throw new TypeError("Session run summaries must be completed or failed");
    }
    const updated = SessionContextSchema.parse({
      ...session,
      runSummaries: [...session.runSummaries, parsedSummary].slice(
        -MAX_SESSION_RUN_SUMMARIES,
      ),
    });
    await writeJsonFileAtomic(this.path, updated);
    return updated;
  }
}
