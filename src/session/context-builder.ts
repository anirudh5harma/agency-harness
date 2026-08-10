import type { SessionContext } from "../domain/index.js";

const MAX_CONTEXT_TURNS = 6;
const MAX_CONTEXT_SUMMARIES = 5;
const MAX_ITEM_LENGTH = 240;

function concise(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_ITEM_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_ITEM_LENGTH - 1)}…`;
}

export function buildFollowUpContext(session: SessionContext): string {
  const userTurns = session.recentTurns
    .filter(({ role }) => role === "user")
    .slice(-MAX_CONTEXT_TURNS);
  const summaries = session.runSummaries.slice(-MAX_CONTEXT_SUMMARIES);
  const sections: string[] = [];

  if (userTurns.length > 0) {
    sections.push(
      [
        "Recent user requests:",
        ...userTurns.map(({ content }) => `- ${concise(content)}`),
      ].join("\n"),
    );
  }

  if (summaries.length > 0) {
    sections.push(
      [
        "Completed/failed runs:",
        ...summaries.map(
          ({ runId, status, objective, summary }) =>
            `- ${runId} (${status}): ${concise(objective)} — ${concise(summary)}`,
        ),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
