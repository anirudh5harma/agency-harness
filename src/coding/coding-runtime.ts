import type {
  AgencyEvent,
  FailureContext,
  Plan,
  RepoContext,
  SessionContext,
} from "../domain/index.js";
import { InfrastructureError } from "../process/index.js";

export type CodingEventSink = (event: AgencyEvent) => void;

export interface CodingRuntimeInput {
  intent: string;
  repo: RepoContext;
  repoInstructions?: string;
  sessionContext?: SessionContext;
  onEvent?: CodingEventSink;
  signal?: AbortSignal;
}

export type CreatePlanInput = CodingRuntimeInput;

export interface ExecuteInput extends CodingRuntimeInput {
  plan: Plan;
}

export interface RepairInput extends ExecuteInput {
  attempt: number;
  failure: FailureContext;
}

export interface CreatePlanResult {
  plan: Plan;
  message: string;
}

export interface CodingResult {
  message: string;
  changedFiles: string[];
  sessionId: string;
}

export interface CodingRuntime {
  createPlan(input: CreatePlanInput): Promise<CreatePlanResult>;
  execute(input: ExecuteInput): Promise<CodingResult>;
  repair(input: RepairInput): Promise<CodingResult>;
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

  readonly #planResults: Array<Queued<CreatePlanResult>> = [];
  readonly #executeResults: Array<Queued<CodingResult>> = [];
  readonly #repairResults: Array<Queued<CodingResult>> = [];
  abortCalls = 0;
  isDisposed = false;

  enqueuePlanResult(result: Queued<CreatePlanResult>): void {
    this.#planResults.push(result);
  }

  enqueueExecuteResult(result: Queued<CodingResult>): void {
    this.#executeResults.push(result);
  }

  enqueueRepairResult(result: Queued<CodingResult>): void {
    this.#repairResults.push(result);
  }

  async createPlan(input: CreatePlanInput): Promise<CreatePlanResult> {
    this.calls.createPlan.push(input);
    return take(this.#planResults, "createPlan");
  }

  async execute(input: ExecuteInput): Promise<CodingResult> {
    this.calls.execute.push(input);
    return take(this.#executeResults, "execute");
  }

  async repair(input: RepairInput): Promise<CodingResult> {
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
