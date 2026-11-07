import type { SixbErrorCode, SixbFailure } from "../../errors/types"
import type { JsonValue } from "../../json"
import type { DatasetVersionRef, DatasetWriteMode } from "../../lake-storage"
import type {
  ClaimRunInput,
  ConfirmRunExecutionInput,
  ListLostRunsInput,
  ReleaseRunExecutionInput,
  RunClaim,
  RunExecution,
} from "../run-claim"

export type SyncRunMode = DatasetWriteMode | "merge"

export type SyncRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"
/** Error codes a sync run can persist and expose through its public contract. */
export const SYNC_RUN_FAILURE_CODES = [
  "internal.unexpected",
  "runtime.cancelled",
  "queue.enqueue_failed",
  "sync.execution_failed",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type SyncRunFailureCode = (typeof SYNC_RUN_FAILURE_CODES)[number]

export interface SyncRunRecord {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly syncId: string
  readonly datasetId: string
  readonly mode: SyncRunMode
  readonly status: SyncRunStatus
  /** Executions this run has used up. 0 until one takes it. */
  readonly attempt: number
  /** Absent unless a worker holds the run. */
  readonly execution?: RunExecution
  /** When an execution last got as far as its commit. Before that, no commit can have landed. */
  readonly commitPreparedAt?: Date
  readonly queuedAt: Date
  readonly startedAt?: Date
  readonly finishedAt?: Date
  /** Source items successfully consumed. Merge runs count both upserts and deletes. */
  readonly rowsRead?: number
  readonly output?: DatasetVersionRef
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
  readonly error?: SixbFailure<SyncRunFailureCode>
  /** On a running run, what its commit will have read if that commit lands. */
  readonly checkpoint?: JsonValue
}

export interface QueueSyncRunInput {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly syncId: string
  readonly datasetId: string
  readonly mode: SyncRunMode
  readonly queuedAt?: Date
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
}

/** What a run writes just before its lake commit, which leaves it nothing else to record. */
export interface PrepareSyncRunCommitInput {
  readonly id: string
  readonly projectId: string
  readonly executionToken: string
  readonly rowsRead: number
  readonly checkpoint?: JsonValue
  /** Defaults to now. */
  readonly preparedAt?: Date
}

export type FinishSyncRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly executionToken?: string
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
      readonly executionToken?: string
      readonly status: "failed"
      readonly finishedAt?: Date
      /** Source items successfully consumed before the failure or cancellation. */
      readonly rowsRead?: number
      readonly error: SixbFailure<SyncRunFailureCode>
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly executionToken?: string
      readonly status: "cancelled"
      readonly finishedAt?: Date
      /** Source items successfully consumed before cancellation. */
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
  queue(input: QueueSyncRunInput): Promise<SyncRunRecord>
  /**
   * Takes the run for one execution, or says why this delivery cannot. One run of a Sync runs at a
   * time: a checkpoint is one cursor, and two runs reading from it would read the same rows.
   */
  startOrReclaim(input: ClaimRunInput): Promise<RunClaim<SyncRunRecord>>
  /** Projects a renewed queue lease onto the run. */
  confirmExecutionOwnership(input: ConfirmRunExecutionInput): Promise<SyncRunRecord>
  /** Hands the run back. Does nothing once the token no longer holds a running run. */
  releaseExecution(input: ReleaseRunExecutionInput): Promise<void>
  listLost(input: ListLostRunsInput): Promise<readonly SyncRunRecord[]>
  prepareCommit(input: PrepareSyncRunCommitInput): Promise<SyncRunRecord>
  finish(input: FinishSyncRunInput): Promise<SyncRunRecord>
  getById(params: { projectId: string; id: string }): Promise<SyncRunRecord | null>
  list(input: ListSyncRunsInput): Promise<ListSyncRunsResult>
  listLatestBySyncIds(input: ListLatestSyncRunsInput): Promise<ListLatestSyncRunsResult>
}
