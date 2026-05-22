import type { JsonValue } from "../../json"

export type ActionRunStatus = "running" | "succeeded" | "failed" | "cancelled"

export interface ActionRunFailure {
  readonly name?: string
  readonly message: string
  readonly phase?: "handler" | "cancelled"
}

export interface ActionRunRecord {
  readonly id: string
  readonly projectId: string
  readonly actionId: string
  readonly objectTypeId: string
  readonly primaryId: string
  readonly status: ActionRunStatus
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly params: Readonly<Record<string, unknown>>
  readonly error?: ActionRunFailure
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

export interface StartActionRunInput {
  readonly id: string
  readonly projectId: string
  readonly actionId: string
  readonly objectTypeId: string
  readonly primaryId: string
  readonly params: Readonly<Record<string, unknown>>
  readonly startedAt?: Date
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

export type FinishActionRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "succeeded"
      readonly finishedAt?: Date
      readonly metadata?: Readonly<Record<string, JsonValue>>
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed" | "cancelled"
      readonly finishedAt?: Date
      readonly error?: ActionRunFailure
      readonly metadata?: Readonly<Record<string, JsonValue>>
    }

export interface ListActionRunsInput {
  readonly projectId: string
  readonly actionId?: string
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
  start(input: StartActionRunInput): Promise<ActionRunRecord>
  finish(input: FinishActionRunInput): Promise<ActionRunRecord>
  getById(params: { projectId: string; id: string }): Promise<ActionRunRecord | null>
  list(input: ListActionRunsInput): Promise<ListActionRunsResult>
}
