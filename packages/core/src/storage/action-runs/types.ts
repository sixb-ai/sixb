import type { ActionSubject } from "../../actions"
import type { EditCommitDiff, EditLinkDiff, EditObjectDiff, EditObjectRef } from "../../edits/types"
import type { JsonValue } from "../../json"

export type ActionRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export type ActionRunPhase =
  | "request"
  | "enqueue"
  | "validation"
  | "writeback"
  | "edits"
  | "commit"
  | "effects"
  | "cancelled"

export type ActionRunParams = Readonly<Record<string, JsonValue>>

export type ActionRunPhaseStatus = "succeeded" | "failed"

export interface ActionRunFailure {
  readonly name?: string
  readonly message: string
  readonly phase?: ActionRunPhase
}

export interface ActionRunWritebackRecord {
  readonly status: ActionRunPhaseStatus
  readonly completedAt: Date
  readonly result?: JsonValue
  readonly error?: ActionRunFailure
}

export type ActionRunObjectEditDiff = EditObjectDiff
export type ActionRunObjectRef = EditObjectRef
export type ActionRunLinkEditDiff = EditLinkDiff
export type ActionRunCommitDiff = EditCommitDiff

export interface ActionRunCommitRecord {
  readonly committedAt: Date
  readonly diff: ActionRunCommitDiff
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
  /** Generic ontology commit linkage written atomically by the materializer. */
  readonly commitId?: string
  readonly writeback?: ActionRunWritebackRecord
  readonly commit?: ActionRunCommitRecord
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

export interface RecordActionCommitInput {
  readonly id: string
  readonly projectId: string
  readonly committedAt?: Date
  readonly diff: ActionRunCommitDiff
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

export interface ActionRunStorage {
  /** @internal Phase 1 materializer linkage; optional until every provider is switched. */
  recordMaterializationCommit?(projectId: string, runId: string, commitId: string): Promise<void>
  /** @internal Attach a replaying run to an already committed materialization. */
  recordMaterializationReplay?(projectId: string, runId: string, commitId: string): Promise<void>
  queue(input: QueueActionRunInput): Promise<ActionRunRecord>
  start(input: StartActionRunInput): Promise<ActionRunRecord>
  enterPhase(input: EnterActionRunPhaseInput): Promise<ActionRunRecord>
  recordWriteback(input: RecordActionWritebackInput): Promise<ActionRunRecord>
  recordCommit(input: RecordActionCommitInput): Promise<ActionRunRecord>
  recordEffects(input: RecordActionEffectsInput): Promise<ActionRunRecord>
  finish(input: FinishActionRunInput): Promise<ActionRunRecord>
  getById(params: { projectId: string; id: string }): Promise<ActionRunRecord | null>
  list(input: ListActionRunsInput): Promise<ListActionRunsResult>
}
