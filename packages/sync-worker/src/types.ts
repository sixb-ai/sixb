import type {
  BlobStorage,
  ConnectorAdapter,
  ConnectorClient,
  ConnectorDefinition,
  DatasetDefinition,
  LakeStorage,
  SyncDefinition,
} from "@sixb/core"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import type { DatasetVersion, DatasetWriteMode } from "@sixb/core/lake-storage"
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
}

export type SyncRunStartedHandler = (run: SyncRunRecord) => Promise<void> | void

export interface SyncRunResult {
  readonly id: string
  readonly syncId: string
  readonly datasetId: string
  readonly mode: DatasetWriteMode
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly rowsRead: number
  readonly version: DatasetVersion
  /** True only when this run created the returned dataset version. */
  readonly versionCreated: boolean
}
