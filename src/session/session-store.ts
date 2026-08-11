import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import {
  MAX_SESSION_RUN_SUMMARIES,
  MAX_SESSION_TURNS,
  EXPLICIT_COMPACT_RUN_SUMMARIES,
  EXPLICIT_COMPACT_TURNS,
  MAX_OLDER_SUMMARY_CHARS,
  RunSummarySchema,
  SessionContextSchema,
  redactSecrets,
  type RunSummary,
  type SessionContext,
} from "../domain/index.js";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/json-file.js";

const PersistedSessionSchema = SessionContextSchema.extend({
  sessionId: z.uuid(),
});

export interface SessionCompactionResult {
  session: SessionContext;
  beforeTurns: number;
  afterTurns: number;
  beforeRunSummaries: number;
  afterRunSummaries: number;
}

function concise(value: string, limit = 300): string {
  const safe = redactSecrets(value).replace(/\s+/gu, " ").trim();
  return safe.length <= limit ? safe : `${safe.slice(0, limit - 1)}…`;
}

function mergeSummary(existing: string, lines: readonly string[]): string {
  const merged = [existing.trim(), ...lines].filter(Boolean).join("\n");
  return merged.length <= MAX_OLDER_SUMMARY_CHARS
    ? merged
    : `…\n${merged.slice(-(MAX_OLDER_SUMMARY_CHARS - 2))}`;
}

function compactSession(
  session: SessionContext,
  keepTurns: number,
  keepRuns: number,
  compactedAt: string,
): SessionContext {
  const evictedTurns = session.recentTurns.slice(0, Math.max(0, session.recentTurns.length - keepTurns));
  const evictedRuns = session.runSummaries.slice(0, Math.max(0, session.runSummaries.length - keepRuns));
  if (evictedTurns.length === 0 && evictedRuns.length === 0) return session;
  const lines = [
    ...evictedTurns.map((turn) => `[turn:${turn.role}] ${concise(turn.content)}`),
    ...evictedRuns.map((run) => `[run:${run.status}] ${concise(run.objective)} — ${concise(run.summary)}`),
  ];
  return SessionContextSchema.parse({
    ...session,
    olderSummary: mergeSummary(session.olderSummary, lines),
    recentTurns: session.recentTurns.slice(-keepTurns),
    runSummaries: session.runSummaries.slice(-keepRuns),
    compactionCount: session.compactionCount + 1,
    lastCompactedAt: compactedAt,
  });
}

export class SessionStore {
  readonly path: string;

  constructor(projectRoot: string) {
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
    const updated = compactSession({
      ...session,
      recentTurns: [...session.recentTurns, turn],
    }, MAX_SESSION_TURNS, MAX_SESSION_RUN_SUMMARIES, new Date().toISOString());
    await writeJsonFileAtomic(this.path, updated);
    return updated;
  }

  async recordRunSummary(summary: RunSummary): Promise<SessionContext> {
    const session = await this.loadOrCreate();
    const parsedSummary = RunSummarySchema.parse(summary);
    const updated = compactSession({
      ...session,
      runSummaries: [...session.runSummaries, parsedSummary],
    }, MAX_SESSION_TURNS, MAX_SESSION_RUN_SUMMARIES, new Date().toISOString());
    await writeJsonFileAtomic(this.path, updated);
    return updated;
  }

  async compact(): Promise<SessionCompactionResult> {
    const session = await this.loadOrCreate();
    const updated = compactSession(
      session,
      EXPLICIT_COMPACT_TURNS,
      EXPLICIT_COMPACT_RUN_SUMMARIES,
      new Date().toISOString(),
    );
    if (updated !== session) await writeJsonFileAtomic(this.path, updated);
    return {
      session: updated,
      beforeTurns: session.recentTurns.length,
      afterTurns: updated.recentTurns.length,
      beforeRunSummaries: session.runSummaries.length,
      afterRunSummaries: updated.runSummaries.length,
    };
  }
}
