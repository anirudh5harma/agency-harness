import { randomUUID } from "node:crypto";

import type { CodingRuntime } from "../coding/index.js";
import { PiCodingRuntime } from "../coding/index.js";
import type { RunSummary, SessionContext } from "../domain/index.js";
import { EventBus } from "../events/index.js";
import {
  createCodingRunGraph,
  type CodingRunGraphRunner,
  type CodingRunState,
} from "../graph/index.js";
import {
  JsonlTrajectoryWriter,
  type TrajectoryWriter,
} from "../observability/index.js";
import {
  createSqliteCheckpointPersistence,
  IncompleteRunRegistry,
  inspectIncompleteRunRecovery,
  type IncompleteRunRecoveryInspection,
  type SqliteCheckpointPersistence,
} from "../persistence/index.js";
import {
  ensureAgencyMetadataIgnored,
  inspectRepository,
  type RepositoryInspection,
} from "../repo/index.js";
import { SessionStore } from "../session/index.js";
import { SlashCommandRouter, type SlashCommandDependencies } from "./commands.js";
import { AgencyRepl, type ReplHandler, type TerminalIO } from "./repl.js";
import {
  PlainTerminalRenderer,
  type TerminalRenderer,
  type TextOutput,
} from "./renderer.js";

const MAX_USER_INTENT_CHARS = 8_000;

export interface SessionStoreBoundary {
  loadOrCreate(): Promise<SessionContext>;
  createNew(): Promise<SessionContext>;
  recordUserTurn(content: string): Promise<SessionContext>;
  recordRunSummary(summary: RunSummary): Promise<SessionContext>;
}

export interface IncompleteRunRegistryBoundary {
  list(): ReturnType<IncompleteRunRegistry["list"]>;
  upsert: IncompleteRunRegistry["upsert"];
  updateStatus: IncompleteRunRegistry["updateStatus"];
}

export interface AgencyApplicationDependencies {
  cwd: string;
  io: TerminalIO;
  output: TextOutput;
  errorOutput: TextOutput;
  inspectRepository?: (cwd: string) => Promise<RepositoryInspection>;
  ensureMetadataIgnored?: (root: string) => Promise<void>;
  sessionStoreFactory?: (root: string) => SessionStoreBoundary;
  eventBusFactory?: () => EventBus;
  rendererFactory?: (
    output: TextOutput,
    errorOutput: TextOutput,
    eventBus: EventBus,
  ) => TerminalRenderer;
  checkpointFactory?: (root: string) => Promise<SqliteCheckpointPersistence>;
  runtimeFactory?: () => Promise<CodingRuntime>;
  registryFactory?: (root: string) => IncompleteRunRegistryBoundary;
  trajectoryWriterFactory?: (root: string) => TrajectoryWriter;
  graphFactory?: (input: {
    runtime: CodingRuntime;
    registry: IncompleteRunRegistryBoundary;
    eventBus: EventBus;
    checkpoint: SqliteCheckpointPersistence;
    trajectoryWriter: TrajectoryWriter;
  }) => CodingRunGraphRunner;
  inspectRecovery?: (
    registry: IncompleteRunRegistryBoundary,
    graph: CodingRunGraphRunner,
  ) => Promise<IncompleteRunRecoveryInspection[]>;
  commandOverrides?: Pick<SlashCommandDependencies, "gitDiff" | "verify">;
  createId?: () => string;
}

export class AgencyApplication implements ReplHandler {
  readonly #io: TerminalIO;
  readonly #renderer: TerminalRenderer;
  readonly #inspection: RepositoryInspection;
  readonly #sessionStore: SessionStoreBoundary;
  readonly #runtime: CodingRuntime;
  readonly #graph: CodingRunGraphRunner;
  readonly #registry: IncompleteRunRegistryBoundary;
  readonly #checkpoint: SqliteCheckpointPersistence;
  readonly #inspectRecovery: NonNullable<AgencyApplicationDependencies["inspectRecovery"]>;
  readonly #commands: SlashCommandRouter;
  readonly #createId: () => string;
  #session: SessionContext;
  #disposed = false;

  private constructor(input: {
    dependencies: AgencyApplicationDependencies;
    inspection: RepositoryInspection;
    sessionStore: SessionStoreBoundary;
    session: SessionContext;
    renderer: TerminalRenderer;
    runtime: CodingRuntime;
    graph: CodingRunGraphRunner;
    registry: IncompleteRunRegistryBoundary;
    checkpoint: SqliteCheckpointPersistence;
  }) {
    this.#io = input.dependencies.io;
    this.#inspection = input.inspection;
    this.#sessionStore = input.sessionStore;
    this.#session = input.session;
    this.#renderer = input.renderer;
    this.#runtime = input.runtime;
    this.#graph = input.graph;
    this.#registry = input.registry;
    this.#checkpoint = input.checkpoint;
    this.#inspectRecovery =
      input.dependencies.inspectRecovery ?? inspectIncompleteRunRecovery;
    this.#createId = input.dependencies.createId ?? randomUUID;
    this.#commands = new SlashCommandRouter({
      projectRoot: input.inspection.rootPath,
      renderer: input.renderer,
      getSession: () => this.#session,
      createNewSession: async () => {
        this.#session = await this.#sessionStore.createNew();
        return this.#session;
      },
      inspect: input.dependencies.inspectRepository ?? inspectRepository,
      ...input.dependencies.commandOverrides,
    });
  }

  static async create(
    dependencies: AgencyApplicationDependencies,
  ): Promise<AgencyApplication> {
    const inspect = dependencies.inspectRepository ?? inspectRepository;
    const inspection = await inspect(dependencies.cwd);
    await (dependencies.ensureMetadataIgnored ?? ensureAgencyMetadataIgnored)(
      inspection.rootPath,
    );
    const sessionStore =
      dependencies.sessionStoreFactory?.(inspection.rootPath) ??
      new SessionStore(inspection.rootPath);
    const session = await sessionStore.loadOrCreate();
    const eventBus = dependencies.eventBusFactory?.() ?? new EventBus();
    const renderer =
      dependencies.rendererFactory?.(
        dependencies.output,
        dependencies.errorOutput,
        eventBus,
      ) ?? new PlainTerminalRenderer(dependencies.output, dependencies.errorOutput, eventBus);
    let checkpoint: SqliteCheckpointPersistence | undefined;
    let runtime: CodingRuntime | undefined;
    try {
      checkpoint = await (
        dependencies.checkpointFactory ?? createSqliteCheckpointPersistence
      )(inspection.rootPath);
      runtime = await (dependencies.runtimeFactory ?? (() => PiCodingRuntime.create()))();
      const registry =
        dependencies.registryFactory?.(inspection.rootPath) ??
        new IncompleteRunRegistry(inspection.rootPath);
      const trajectoryWriter =
        dependencies.trajectoryWriterFactory?.(inspection.rootPath) ??
        new JsonlTrajectoryWriter(inspection.rootPath);
      const graph = dependencies.graphFactory?.({
        runtime,
        registry,
        eventBus,
        checkpoint,
        trajectoryWriter,
      }) ??
        createCodingRunGraph(
          {
            runtime,
            registry,
            eventBus,
            trajectoryWriter,
            // Bootstrap already established the local exclusion before persistence.
            ensureMetadataIgnored: async () => {},
          },
          { checkpointer: checkpoint.checkpointer },
        );
      return new AgencyApplication({
        dependencies,
        inspection,
        sessionStore,
        session,
        renderer,
        runtime,
        graph,
        registry,
        checkpoint,
      });
    } catch (error) {
      await runtime?.dispose();
      checkpoint?.close();
      renderer.dispose();
      throw error;
    }
  }

  async run(): Promise<void> {
    this.#renderer.header(this.#inspection);
    await this.#offerRecovery();
    await new AgencyRepl(this.#io, this).run();
  }

  async handle(line: string, signal: AbortSignal): Promise<"continue" | "exit"> {
    if (line.startsWith("/")) {
      try {
        return await this.#commands.execute(line, signal);
      } catch (error) {
        if (signal.aborted) this.#renderer.message("Cancelled.");
        else this.#renderer.error(error instanceof Error ? error.message : String(error));
        return "continue";
      }
    }

    const intent = line.slice(0, MAX_USER_INTENT_CHARS);
    const sessionContext = await this.#sessionStore.recordUserTurn(intent);
    this.#session = sessionContext;
    const runId = this.#createId();
    const threadId = this.#createId();
    try {
      const state = await this.#graph.invoke(
        {
          runId,
          threadId,
          sessionId: sessionContext.sessionId,
          repoPath: this.#inspection.rootPath,
          userIntent: intent,
          sessionContext,
        },
        { threadId, signal },
      );
      if (signal.aborted) {
        this.#renderer.message("Cancelled.");
        return "continue";
      }
      await this.#recordTerminalState(state);
      this.#renderer.run(state);
      if (state.failure?.stage !== "finalizing") {
        await this.#pruneTerminalCheckpoint(state.threadId);
      }
    } catch (error) {
      if (signal.aborted) this.#renderer.message("Cancelled.");
      else this.#renderer.error(error instanceof Error ? error.message : String(error));
    }
    return "continue";
  }

  async interruptActive(): Promise<void> {
    await this.#runtime.abort();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#io.close();
    await this.#runtime.dispose();
    this.#checkpoint.close();
    this.#renderer.dispose();
  }

  async #offerRecovery(): Promise<void> {
    let activeController: AbortController | null = null;
    const detachInterrupt = this.#io.onInterrupt(() => {
      if (activeController === null) {
        this.#io.close();
      } else {
        activeController.abort();
        void this.#runtime.abort();
      }
    });
    try {
      const inspections = await this.#inspectRecovery(this.#registry, this.#graph);
      for (const inspection of inspections) {
        if (inspection.status !== "terminal_checkpoint") continue;
        try {
          await this.#registry.updateStatus(
            inspection.entry.runId,
            inspection.terminalStatus,
            new Date().toISOString(),
          );
        } catch (error) {
          this.#renderer.recovery(
            `Run ${inspection.entry.runId} reached a terminal checkpoint, but its recovery record could not be reconciled: ${error instanceof Error ? error.message : String(error)}.`,
          );
          continue;
        }
        this.#renderer.recovery(
          `Run ${inspection.entry.runId} terminal checkpoint reconciled.`,
        );
        await this.#pruneTerminalCheckpoint(inspection.entry.threadId);
      }
      for (const inspection of inspections.filter(
        ({ status }) => status !== "resumable" && status !== "terminal_checkpoint",
      )) {
        this.#renderer.recovery(
          `${inspection.entry.runId} cannot resume (${inspection.status.replaceAll("_", " ")}).`,
        );
      }
      const candidate = inspections
        .filter(
          (inspection): inspection is Extract<IncompleteRunRecoveryInspection, { status: "resumable" }> =>
            inspection.status === "resumable",
        )
        .sort((left, right) => right.entry.updatedAt.localeCompare(left.entry.updatedAt))[0];
      if (candidate === undefined) return;

      while (true) {
        const answer = await this.#io.readLine(
          `Resume incomplete task “${candidate.entry.userIntent}”? [r/n] `,
        );
        if (answer === null) return;
        const normalized = answer.trim().toLowerCase();
        if (normalized === "r") {
          activeController = new AbortController();
          const state = await this.#graph.resume(candidate.entry.threadId, {
            signal: activeController.signal,
          });
          if (activeController.signal.aborted) {
            this.#renderer.message("Cancelled.");
            return;
          }
          await this.#recordTerminalState(state);
          this.#renderer.run(state);
          if (state.failure?.stage !== "finalizing") {
            await this.#pruneTerminalCheckpoint(state.threadId);
          }
          return;
        }
        if (normalized === "n") {
          this.#session = await this.#sessionStore.createNew();
          this.#renderer.recovery(
            `Started session ${this.#session.sessionId}; recovery record ${candidate.entry.runId} was preserved.`,
          );
          return;
        }
        this.#renderer.message("Enter r to resume or n to start a fresh session.");
      }
    } finally {
      detachInterrupt();
    }
  }

  async #recordTerminalState(state: CodingRunState): Promise<void> {
    if (state.status !== "completed" && state.status !== "failed") return;
    if (state.sessionId !== this.#session.sessionId) {
      this.#renderer.recovery(
        `Run ${state.runId} belongs to session ${state.sessionId}; the current session was left unchanged.`,
      );
      return;
    }
    this.#session = await this.#sessionStore.recordRunSummary({
      runId: state.runId,
      status: state.status,
      objective: state.codingPlan?.objective ?? state.userIntent,
      summary: state.summary,
      ...(state.verification === null ? {} : { verification: state.verification }),
      changedFiles: state.changedFiles,
    });
  }

  async #pruneTerminalCheckpoint(threadId: string): Promise<void> {
    try {
      await this.#checkpoint.deleteThread(threadId);
    } catch (error) {
      this.#renderer.recovery(
        `Warning: could not prune terminal checkpoint ${threadId}: ${error instanceof Error ? error.message : String(error)}. The terminal result was preserved.`,
      );
    }
  }
}
