import type {
  BlobStorage,
  ConnectorRuntime,
  LakeStorage,
  SixbDefinitions,
  SyncMode,
} from "@sixb/core"
import type { LoggingService } from "@sixb/core/internal/logging"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { SyncRunRecord, SyncRunStorage } from "@sixb/core/storage"

export interface SyncWorkerContext {
  readonly id: string
  readonly syncRunsStorage: SyncRunStorage
  readonly lakeStorage: LakeStorage
  readonly blobs: BlobStorage
  readonly logging?: LoggingService

  readonly datasets: Pick<SixbDefinitions["datasets"], "getById">
  readonly syncs: Pick<SixbDefinitions["syncs"], "getById">
  readonly connector: ConnectorRuntime
}

export interface SyncJob {
  readonly id: string
  readonly syncId: string
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
}

export interface RunSyncJobInput {
  readonly runtime: SyncWorkerContext
  readonly job: SyncJob
  readonly signal?: AbortSignal
  readonly onRunStarted?: SyncRunStartedHandler
  readonly onRunFinished?: SyncRunFinishedHandler
  readonly onRunFailed?: SyncRunFailedHandler
}

export type SyncRunStartedHandler = (run: SyncRunRecord) => Promise<void> | void

export type SyncRunFinishedHandler = (
  run: SyncRunRecord,
  /** Dataset version created by this run, when the durable output is new. */
  createdVersion?: DatasetVersion
) => Promise<void> | void

export type SyncRunFailedHandler = (error: unknown, run: SyncRunRecord) => void

interface SyncRunResultBase {
  readonly id: string
  readonly syncId: string
  readonly datasetId: string
  readonly mode: SyncMode
  readonly startedAt: Date
  readonly finishedAt: Date
  /** Source items successfully consumed. Merge runs count both upserts and deletes. */
  readonly rowsRead: number
}

export type SyncRunResult = SyncRunResultBase &
  (
    | {
        readonly version: DatasetVersion
        /** True only when this run created the returned dataset version. */
        readonly versionCreated: boolean
      }
    | {
        /** A successful initial no-op has no dataset version yet. */
        readonly version?: undefined
        readonly versionCreated: false
      }
  )
