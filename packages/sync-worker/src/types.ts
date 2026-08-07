import type {
  BlobStorage,
  ConnectorAdapter,
  ConnectorClient,
  ConnectorDefinition,
  DatasetDefinition,
  LakeStorage,
  SyncDefinition,
  SyncMode,
} from "@sixb/core"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { SyncRunRecord, SyncRunStorage } from "@sixb/core/storage"

export interface SyncWorkerContext {
  readonly id: string
  readonly syncRunsStorage: SyncRunStorage
  readonly lakeStorage: LakeStorage
  readonly blobStorage: BlobStorage
  readonly logs?: LogsRuntime

  getDatasetById(datasetId: string): DatasetDefinition | null
  getSyncById(syncId: string): SyncDefinition | null

  connector<TAdapter extends ConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<ConnectorClient<TAdapter>>
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
  readonly onRunFailed?: SyncRunFailedHandler
}

export type SyncRunStartedHandler = (run: SyncRunRecord) => Promise<void> | void

export type SyncRunFailedHandler = (error: unknown, run: SyncRunRecord) => void

interface SyncRunResultBase {
  readonly id: string
  readonly syncId: string
  readonly datasetId: string
  readonly mode: SyncMode
  readonly startedAt: Date
  readonly finishedAt: Date
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
