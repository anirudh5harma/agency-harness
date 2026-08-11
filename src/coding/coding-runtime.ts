import type {
  AgencyEvent,
  FailureContext,
  HumanDecisionRequest,
  HumanDecisionResolution,
  Plan,
  RepoContext,
  SessionContext,
} from "../domain/index.js";
import { InfrastructureError } from "../process/index.js";

export type CodingEventSink = (event: AgencyEvent) => void;

export interface RuntimeContinuation {
  role: "planner" | "executor";
  /** Basename only; resolved and validated beneath Agency-owned session storage. */
  sessionFile: string;
}

export interface CodingRuntimeInput {
  intent: string;
  repo: RepoContext;
  repoInstructions?: string;
  sessionContext?: SessionContext;
  onEvent?: CodingEventSink;
  signal?: AbortSignal;
  /** Stable conversation identity for continuing a paused model session. */
  sessionId?: string;
  /** Validated answer to the runtime's immediately preceding request. */
  humanDecision?: HumanDecisionResolution;
  runtimeContinuation?: RuntimeContinuation;
}

export type CreatePlanInput = CodingRuntimeInput;

export interface ExecuteInput extends CodingRuntimeInput {
  plan: Plan;
  /** Stable Agency conversation identity used to isolate persistent Pi executors. */
  sessionId: string;
}

export interface RepairInput extends ExecuteInput {
  attempt: number;
  failure: FailureContext;
  /** Git delta measured by Agency, not files self-reported by Pi. */
  changedFiles: string[];
}

export interface CreatePlanResult {
  plan: Plan;
  message: string;
}

export interface HumanDecisionResult {
  decisionRequest: HumanDecisionRequest;
  message: string;
  runtimeContinuation?: RuntimeContinuation;
}

export interface CodingResult {
  message: string;
  changedFiles: string[];
  sessionId: string;
}

export interface CodingRuntime {
  createPlan(input: CreatePlanInput): Promise<CreatePlanResult | HumanDecisionResult>;
  execute(input: ExecuteInput): Promise<CodingResult | HumanDecisionResult>;
  repair(input: RepairInput): Promise<CodingResult | HumanDecisionResult>;
  abort(): Promise<void>;
  dispose(): Promise<void> | void;
}

type Queued<T> = T | Error;

function take<T>(queue: Array<Queued<T>>, operation: string): T {
  const item = queue.shift();
  if (item === undefined) {
    throw new InfrastructureError(
      "CODING_RUNTIME_RESULT_UNAVAILABLE",
      `No queued fake result for ${operation}`,
    );
  }
  if (item instanceof Error) throw item;
  return item;
}

export class FakeCodingRuntime implements CodingRuntime {
  readonly calls: {
    createPlan: CreatePlanInput[];
    execute: ExecuteInput[];
    repair: RepairInput[];
  } = { createPlan: [], execute: [], repair: [] };

  readonly #planResults: Array<Queued<CreatePlanResult | HumanDecisionResult>> = [];
  readonly #executeResults: Array<Queued<CodingResult | HumanDecisionResult>> = [];
  readonly #repairResults: Array<Queued<CodingResult | HumanDecisionResult>> = [];
  abortCalls = 0;
  isDisposed = false;

  enqueuePlanResult(result: Queued<CreatePlanResult | HumanDecisionResult>): void {
    this.#planResults.push(result);
  }

  enqueueExecuteResult(result: Queued<CodingResult | HumanDecisionResult>): void {
    this.#executeResults.push(result);
  }

  enqueueRepairResult(result: Queued<CodingResult | HumanDecisionResult>): void {
    this.#repairResults.push(result);
  }

  async createPlan(input: CreatePlanInput): Promise<CreatePlanResult | HumanDecisionResult> {
    this.calls.createPlan.push(input);
    return take(this.#planResults, "createPlan");
  }

  async execute(input: ExecuteInput): Promise<CodingResult | HumanDecisionResult> {
    this.calls.execute.push(input);
    return take(this.#executeResults, "execute");
  }

  async repair(input: RepairInput): Promise<CodingResult | HumanDecisionResult> {
    this.calls.repair.push(input);
    return take(this.#repairResults, "repair");
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
  }
}
