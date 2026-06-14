import type { ActionSubject } from "../../actions"
import type { SecurityContext } from "../../auth"
import type { JsonValue } from "../../json"

export type ActionRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export type ActionRunPhase = "request" | "enqueue" | "handler" | "cancelled"

export type ActionRunParams = Readonly<Record<string, JsonValue>>

export interface ActionRunFailure {
  readonly name?: string
  readonly message: string
  readonly phase?: ActionRunPhase
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
  readonly securityContext?: SecurityContext
  readonly error?: ActionRunFailure
}

export interface QueueActionRunInput {
  readonly id: string
  readonly projectId: string
  readonly actionId: string
  readonly subject: ActionSubject
  readonly params: ActionRunParams
  readonly idempotencyKey: string
  readonly securityContext?: SecurityContext
  readonly queuedAt?: Date
}

export interface StartActionRunInput {
  readonly id: string
  readonly projectId: string
  readonly startedAt?: Date
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
  readonly subject?: ActionSubject
  readonly objectTypeId?: string
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
  queue(input: QueueActionRunInput): Promise<ActionRunRecord>
  start(input: StartActionRunInput): Promise<ActionRunRecord>
  finish(input: FinishActionRunInput): Promise<ActionRunRecord>
  getById(params: { projectId: string; id: string }): Promise<ActionRunRecord | null>
  list(input: ListActionRunsInput): Promise<ListActionRunsResult>
}
