import type { ActionSubject } from "../../actions"
import {
  parseSixbFailure,
  type SixbFailure,
  serializeSixbFailure,
  toSixbFailure,
} from "../../errors"
import type { JsonValue } from "../../json"

export type ActionRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

/**
 * The phases an action run moves through, as a value.
 *
 * A list rather than a bare union because the phase of a *failure* now travels inside a JSON
 * column, so reading one back means checking it at runtime — and that check should not be a fourth
 * copy of the list after the type and the two dialects' `CHECK` on the run's own `phase` column.
 */
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

export function isActionRunPhase(value: unknown): value is ActionRunPhase {
  return typeof value === "string" && (ACTION_RUN_PHASES as readonly string[]).includes(value)
}

export type ActionRunParams = Readonly<Record<string, JsonValue>>

export type ActionRunPhaseStatus = "succeeded" | "failed"

/**
 * The one place a primitive extends {@link SixbFailure} rather than reusing it as-is.
 *
 * `phase` is a closed union the whole action pipeline branches on, so it is a typed field and not a
 * `details` key. That is the rule: extend the failure record, never re-specify it.
 */
export interface ActionRunFailure extends SixbFailure {
  readonly phase?: ActionRunPhase
}

/**
 * Builds an action run's failure: the shared record, filed under the action's own code, plus the
 * phase it died in.
 *
 * Named rather than spread at each call site. A worker that writes `{ ...toSixbFailure(e), phase }`
 * inline is one keystroke from filing an action failure as `runtime.unexpected`, and the shape of
 * what it wrote is invisible where it is read.
 */
export function toActionRunFailure(error: unknown, phase: ActionRunPhase): ActionRunFailure {
  return { ...toSixbFailure(error, { fallbackCode: "action.failed" }), phase }
}

/**
 * Reads an action run's failure column, phase included.
 *
 * Here rather than in each provider because the extension is what needs the extra read, and both
 * dialects need it identically: Postgres hands back parsed `JSONB`, SQLite the `TEXT` it stored, so
 * the column is decoded once up front and `phase` comes off the same object the base record did. A
 * string that will not parse is passed through untouched, so it is reported as an unreadable record
 * rather than silently becoming no failure at all.
 */
export function parseActionRunFailure(stored: JsonValue | undefined): ActionRunFailure | undefined {
  const decoded = typeof stored === "string" ? tryParseJson(stored) : stored
  const failure = parseSixbFailure(decoded)
  if (!failure) return undefined

  const phase =
    typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
      ? decoded.phase
      : undefined
  return isActionRunPhase(phase) ? { ...failure, phase } : failure
}

/**
 * Writes an action run's failure column, defaulting the phase to the slot being written.
 *
 * The default belongs here and not in each provider: which phase a `writeback_error` implies is a
 * property of the record, and spelling it out at the call site was six near-identical spreads across
 * two dialects.
 */
export function serializeActionRunFailure(
  failure: ActionRunFailure | undefined,
  phase: ActionRunPhase
): string | null {
  if (!failure) return null
  return serializeSixbFailure(failure.phase ? failure : { ...failure, phase })
}

function tryParseJson(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue
  } catch {
    return value
  }
}

export interface ActionRunWritebackRecord {
  readonly status: ActionRunPhaseStatus
  readonly completedAt: Date
  readonly result?: JsonValue
  readonly error?: ActionRunFailure
}

export interface ActionRunEffectsRecord {
  readonly status: ActionRunPhaseStatus
  readonly completedAt: Date
  readonly error?: ActionRunFailure
}

export interface ActionRunRecord {
  readonly id: string
  readonly projectId: string
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
      readonly error: ActionRunFailure
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
      readonly error: ActionRunFailure
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
      readonly error?: ActionRunFailure
      readonly phase?: ActionRunPhase
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
