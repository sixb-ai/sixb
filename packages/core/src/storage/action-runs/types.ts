import type { ActionSubject } from "../../actions"
import type { SixbErrorCode, SixbFailure } from "../../errors/types"
import type { JsonValue } from "../../json"

export type ActionRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export const ACTION_RUN_PHASES = [
  "request",
  "enqueue",
  "validation",
  "writeback",
  "edits",
  "commit",
  "effects",
  "cancelled",
] as const

export type ActionRunPhase = (typeof ACTION_RUN_PHASES)[number]

export type ActionRunParams = Readonly<Record<string, JsonValue>>

export type ActionRunPhaseStatus = "succeeded" | "failed"

/** Error codes an action run or phase record can persist and expose. */
export const ACTION_RUN_FAILURE_CODES = [
  "internal.unexpected",
  "runtime.cancelled",
  "queue.enqueue_failed",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type ActionRunFailureCode = (typeof ACTION_RUN_FAILURE_CODES)[number]

export interface ActionRunFailureDetails<TPhase extends ActionRunPhase = ActionRunPhase> {
  readonly actionId: string
  readonly runId: string
  readonly phase: TPhase
}

/** Portable failure record with Action's required correlation details. */
export interface ActionRunFailure<TPhase extends ActionRunPhase = ActionRunPhase>
  extends Omit<SixbFailure<ActionRunFailureCode>, "details"> {
  readonly details: ActionRunFailureDetails<TPhase>
}

export type ActionRunWritebackRecord =
  | {
      readonly status: "succeeded"
      readonly completedAt: Date
      readonly result: JsonValue
      readonly error?: never
    }
  | {
      readonly status: "failed"
      readonly completedAt: Date
      readonly result?: never
      readonly error: ActionRunFailure<"writeback">
    }

export type ActionRunEffectsRecord =
  | {
      readonly status: "succeeded"
      readonly completedAt: Date
      readonly error?: never
    }
  | {
      readonly status: "failed"
      readonly completedAt: Date
      readonly error: ActionRunFailure<"effects">
    }

export interface ActionRunRecord {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly actionId: string
  readonly subject: ActionSubject
  readonly status: ActionRunStatus
  readonly phase?: ActionRunPhase
  readonly queuedAt: Date
  readonly startedAt?: Date
  readonly finishedAt?: Date
  readonly params: ActionRunParams
  readonly idempotencyKey: string
  readonly writeback?: ActionRunWritebackRecord
  readonly effects?: ActionRunEffectsRecord
  readonly error?: ActionRunFailure
}

export interface QueueActionRunInput {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly actionId: string
  readonly subject: ActionSubject
  readonly params: ActionRunParams
  readonly idempotencyKey: string
  readonly queuedAt?: Date
}

export interface StartActionRunInput {
  readonly id: string
  readonly projectId: string
  readonly startedAt?: Date
  readonly phase?: Extract<ActionRunPhase, "validation">
}

export interface EnterActionRunPhaseInput {
  readonly id: string
  readonly projectId: string
  readonly phase: Extract<
    ActionRunPhase,
    "validation" | "writeback" | "edits" | "commit" | "effects"
  >
}

export type RecordActionWritebackInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "succeeded"
      readonly completedAt?: Date
      readonly result: JsonValue
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed"
      readonly completedAt?: Date
      readonly error: ActionRunFailure<"writeback">
    }

export type RecordActionEffectsInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "succeeded"
      readonly completedAt?: Date
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed"
      readonly completedAt?: Date
      readonly error: ActionRunFailure<"effects">
    }

export type FinishActionRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "succeeded"
      readonly finishedAt?: Date
      readonly phase?: ActionRunPhase
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed" | "cancelled"
      readonly finishedAt?: Date
      readonly error: ActionRunFailure
    }

export interface ListActionRunsInput {
  readonly projectId: string
  readonly actionId?: string
  readonly actionIds?: readonly string[]
  readonly subject?: ActionSubject
  readonly objectTypeId?: string
  readonly objectTypeIds?: readonly string[]
  readonly primaryId?: string
  readonly statuses?: readonly ActionRunStatus[]
  readonly startedAfter?: Date
  readonly startedBefore?: Date
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListActionRunsResult {
  readonly runs: readonly ActionRunRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface LockActionMaterializationRunInput {
  readonly projectId: string
  readonly actionId: string
  readonly runId: string
}

export interface ActionRunStorage {
  /** Transactional fence for Action identity and running state before a new ontology commit. */
  lockForMaterialization(input: LockActionMaterializationRunInput): Promise<ActionRunRecord>
  queue(input: QueueActionRunInput): Promise<ActionRunRecord>
  start(input: StartActionRunInput): Promise<ActionRunRecord>
  enterPhase(input: EnterActionRunPhaseInput): Promise<ActionRunRecord>
  recordWriteback(input: RecordActionWritebackInput): Promise<ActionRunRecord>
  recordEffects(input: RecordActionEffectsInput): Promise<ActionRunRecord>
  finish(input: FinishActionRunInput): Promise<ActionRunRecord>
  getById(params: { projectId: string; id: string }): Promise<ActionRunRecord | null>
  list(input: ListActionRunsInput): Promise<ListActionRunsResult>
}
