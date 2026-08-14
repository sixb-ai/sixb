import type { SixbErrorCode, SixbFailure } from "../../errors/types"
import type { JsonValue } from "../../json"
import type { DatasetVersionRef, DatasetWriteMode } from "../../lake-storage"

export type SyncRunMode = DatasetWriteMode | "merge"

export type SyncRunStatus = "running" | "succeeded" | "failed" | "cancelled"

/** Error codes a sync run can persist and expose through its public contract. */
export const SYNC_RUN_FAILURE_CODES = [
  "internal.unexpected",
  "runtime.cancelled",
  "sync.execution_failed",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type SyncRunFailureCode = (typeof SYNC_RUN_FAILURE_CODES)[number]

export interface SyncRunRecord {
  readonly id: string
  readonly projectId: string
  readonly syncId: string
  readonly datasetId: string
  readonly mode: SyncRunMode
  readonly status: SyncRunStatus
  readonly startedAt: Date
  readonly finishedAt?: Date
  /** Source items successfully consumed. Merge runs count both upserts and deletes. */
  readonly rowsRead?: number
  readonly output?: DatasetVersionRef
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
  readonly error?: SixbFailure<SyncRunFailureCode>
  readonly checkpoint?: JsonValue
}

export interface StartSyncRunInput {
  readonly id: string
  readonly projectId: string
  readonly syncId: string
  readonly datasetId: string
  readonly mode: SyncRunMode
  readonly startedAt?: Date
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
}

export type FinishSyncRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "succeeded"
      readonly finishedAt?: Date
      /** Source items successfully consumed. Merge runs count both upserts and deletes. */
      readonly rowsRead: number
      /** Absent when a successful run has no dataset version to reference. */
      readonly output?: DatasetVersionRef
      readonly checkpoint?: JsonValue
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly status: "failed" | "cancelled"
      readonly finishedAt?: Date
      /** Source items successfully consumed before the failure or cancellation. */
      readonly rowsRead?: number
      readonly error?: SixbFailure<SyncRunFailureCode>
    }

export interface ListSyncRunsInput {
  readonly projectId: string
  readonly syncId?: string
  readonly syncIds?: readonly string[]
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

export interface ListLatestSyncRunsInput {
  readonly projectId: string
  readonly syncIds: readonly string[]
}

export interface ListLatestSyncRunsResult {
  readonly runs: readonly SyncRunRecord[]
}

export interface SyncRunStorage {
  start(input: StartSyncRunInput): Promise<SyncRunRecord>
  finish(input: FinishSyncRunInput): Promise<SyncRunRecord>
  getById(params: { projectId: string; id: string }): Promise<SyncRunRecord | null>
  list(input: ListSyncRunsInput): Promise<ListSyncRunsResult>
  listLatestBySyncIds(input: ListLatestSyncRunsInput): Promise<ListLatestSyncRunsResult>
}
