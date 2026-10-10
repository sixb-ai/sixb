import type { ActionSubject } from "../../actions"
import type { SixbErrorCode, SixbFailure } from "../../errors/types"
import type { JsonValue } from "../../json"

/**
 * How a run ended. A run is recorded once, when it ends: while it executes, the request that runs
 * it is its only state.
 */
export type ActionRunStatus = "succeeded" | "failed"

/** The phases of a run, in the order it reaches them. */
export const ACTION_RUN_PHASES = ["validation", "writeback", "edits", "commit", "effects"] as const

export type ActionRunPhase = (typeof ACTION_RUN_PHASES)[number]

export type ActionRunParams = Readonly<Record<string, JsonValue>>

/** Error codes an action run or phase record can persist and expose. */
export const ACTION_RUN_FAILURE_CODES = [
  "internal.unexpected",
  "runtime.cancelled",
  "action.phase_failed",
  "action.read_conflict",
  "action.timeout",
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

interface ActionRunRecordFields {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly actionId: string
  readonly subject: ActionSubject
  /** The last phase the run reached. */
  readonly phase: ActionRunPhase
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly params: ActionRunParams
  readonly idempotencyKey: string
  readonly writeback?: ActionRunWritebackRecord
}

/** A run's terminal record, as it is written once when the run ends. */
export type RecordActionRunInput =
  | (ActionRunRecordFields & { readonly status: "succeeded"; readonly error?: never })
  | (ActionRunRecordFields & { readonly status: "failed"; readonly error: ActionRunFailure })

/**
 * A recorded run. Its effects run after its record is written, so their outcome is the one part
 * recorded later, on a succeeded run that committed edits.
 */
export type ActionRunRecord = RecordActionRunInput & {
  readonly effects?: ActionRunEffectsRecord
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

export interface ActionRunStorage {
  /**
   * Insert a run's terminal record.
   *
   * A run is recorded once: a run id that already has a record is refused with an
   * `ActionRunError`, and so is an execution that already recorded another run. The execution must
   * be the trusted primitive execution created for this run.
   */
  record(input: RecordActionRunInput): Promise<ActionRunRecord>
  /**
   * Record the outcome of the effects of a succeeded run that committed edits, once. Recording an
   * equal outcome again returns the run unchanged.
   */
  recordEffects(input: RecordActionEffectsInput): Promise<ActionRunRecord>
  getById(params: { projectId: string; id: string }): Promise<ActionRunRecord | null>
  /** Runs ordered by `startedAt`, then id. */
  list(input: ListActionRunsInput): Promise<ListActionRunsResult>
}
