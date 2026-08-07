import type { DatasetProducer, DatasetSchema } from "@sixb/core"
import type {
  BeginDatasetMergeInput,
  BeginDatasetWriteInput,
  CommitDatasetMergeInput,
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
  /** Canonical content key per staged row, used for row counts and unchanged-write detection. */
  readonly rowKeys: readonly string[]
  readonly primaryKeys: readonly string[]
  readonly sessionDir: string
  readonly tempRowsPath: string
}

export interface CommitMergeInput {
  readonly merge: BeginDatasetMergeInput
  readonly commit?: CommitDatasetMergeInput
  readonly baseVersionId: string | null
  readonly sessionDir: string
  readonly tempRowsPath: string
}

export interface StoredManifestInput {
  readonly version: DatasetVersion
  readonly rowFile: string
  readonly commitMessage?: string
}
