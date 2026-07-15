import type { DatasetProducer, DatasetSchema } from "@sixb/core"
import type {
  BeginDatasetWriteInput,
  CommitDatasetWriteInput,
  DatasetVersion,
  DatasetVersionMode,
  DatasetVersionRef,
} from "@sixb/core/lake-storage"

export interface LocalLakeStorageOptions {
  /** Base directory for lake metadata and row files. */
  path?: string
}

export interface DatasetState {
  readonly latestVersionId?: string
}

export interface StoredDatasetVersionManifest {
  readonly datasetId: string
  readonly versionId: string
  readonly parentVersionId?: string
  readonly mode: DatasetVersionMode
  readonly createdAt: string
  readonly schema: DatasetSchema
  readonly producer?: DatasetProducer
  readonly inputs?: readonly DatasetVersionRef[]
  readonly rowCount?: number
  readonly sizeBytes?: number
  // Persist the row file name in metadata so the manifest stays self-describing.
  readonly rowFile: string
  readonly commitMessage?: string
}

export interface CommitWriteInput {
  readonly write: BeginDatasetWriteInput
  readonly commit?: CommitDatasetWriteInput
  readonly rowCount: number
  readonly sessionDir: string
  readonly tempRowsPath: string
}

export interface StoredManifestInput {
  readonly version: DatasetVersion
  readonly rowFile: string
  readonly commitMessage?: string
}
