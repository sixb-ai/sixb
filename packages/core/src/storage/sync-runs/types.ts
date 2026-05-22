import type { JsonValue } from "../../json"
import type { DatasetVersionRef, DatasetWriteMode } from "../../lake-storage"

export type SyncRunStatus = "running" | "succeeded" | "failed" | "cancelled"

export interface SyncRunFailure {
  readonly name?: string // Example: "AbortError"
  readonly message: string // Example: "Sync cancelled by request"
}

export interface SyncRunRecord {
  readonly id: string
  readonly projectId: string
  readonly syncId: string
  readonly datasetId: string
  readonly mode: DatasetWriteMode
  readonly status: SyncRunStatus
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly rowsRead?: number // Rows produced by this run, not the dataset's full visible row count.
  readonly output?: DatasetVersionRef
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
  readonly error?: SyncRunFailure
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

export interface StartSyncRunInput {
  readonly id: string
  readonly projectId: string
  readonly syncId: string
  readonly datasetId: string
  readonly mode: DatasetWriteMode
  readonly startedAt?: Date
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

export type FinishSyncRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "succeeded"
      readonly finishedAt?: Date
      readonly rowsRead: number
      readonly output: DatasetVersionRef
      readonly metadata?: Readonly<Record<string, JsonValue>>
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed" | "cancelled"
      readonly finishedAt?: Date
      readonly rowsRead?: number
      readonly error?: SyncRunFailure
      readonly metadata?: Readonly<Record<string, JsonValue>>
    }

export interface ListSyncRunsInput {
  readonly projectId: string
  readonly syncId?: string
  readonly datasetId?: string
  readonly statuses?: readonly SyncRunStatus[]
  readonly startedAfter?: Date
  readonly startedBefore?: Date
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListSyncRunsResult {
  readonly runs: readonly SyncRunRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface SyncRunStorage {
  start(input: StartSyncRunInput): Promise<SyncRunRecord>
  finish(input: FinishSyncRunInput): Promise<SyncRunRecord>
  getById(params: { projectId: string; id: string }): Promise<SyncRunRecord | null>
  list(input: ListSyncRunsInput): Promise<ListSyncRunsResult>
}
