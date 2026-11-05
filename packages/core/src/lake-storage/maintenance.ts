import type { DatasetVersionRef } from "./types"

/**
 * Optional lake maintenance a provider runs on request: retention of old versions and their
 * files, and a description of how each dataset is stored. Compaction is not part of it: a provider
 * that compacts does so on its own, after the writes that need it.
 */
export interface LakeMaintenance {
  /**
   * Expires versions nothing may read anymore, then deletes the files only they read. One call is
   * one bounded pass: run it again while `hasMore` is true.
   *
   * A version expires once a newer version of its dataset has replaced it for `keepVersionsForMs`.
   * A reader that resolved a dataset's latest version, such as a pipeline step reading its
   * inputs, can therefore read it for at least that long. Each dataset's latest version and the
   * `protect` versions are always kept.
   */
  applyRetention(options?: LakeRetentionOptions): Promise<LakeRetentionReport>

  /** How each dataset is stored, in the order requested. Bounded catalog reads; no data scans. */
  describeStorage(datasetIds: readonly string[]): Promise<readonly DatasetStorageHealth[]>
}

export interface LakeRetentionOptions {
  /**
   * How long a version stays readable after a newer version of its dataset replaced it.
   * Default: 7 days. At least 1 hour.
   */
  readonly keepVersionsForMs?: number
  /**
   * How long a file no kept version reads stays in storage before it is deleted.
   * Default: 7 days. At least 1 hour.
   */
  readonly deleteFilesAfterMs?: number
  /** Versions to keep whatever their age, such as the versions projections applied. */
  readonly protect?: readonly DatasetVersionRef[]
  /** Report what the pass would expire and delete without changing anything. Default: false. */
  readonly dryRun?: boolean
  /** Most versions one pass expires, and most files it deletes. Default: 1,000. */
  readonly limit?: number
}

export interface LakeRetentionReport {
  readonly dryRun: boolean
  readonly keepVersionsForMs: number
  readonly deleteFilesAfterMs: number
  /** Versions expired, or that would expire on a dry run, with the provider's own maintenance commits. */
  readonly expiredVersions: number
  /** Versions past retention kept because they are protected. */
  readonly keptVersions: number
  /** Files deleted, or that would be deleted on a dry run. */
  readonly deletedFiles: number
  /** Files no version references, such as those an interrupted write left, deleted. */
  readonly orphanedFiles: number
  /** The pass stopped at its limit: another pass has more to expire or delete. */
  readonly hasMore: boolean
}

/** How one dataset is stored, as a Console page shows it. */
export interface DatasetStorageHealth {
  readonly datasetId: string
  /** Whether the dataset has a table in the lake. Every count is 0 when it has none. */
  readonly materialized: boolean
  /** Rows the dataset holds now, from storage statistics. */
  readonly rowCount: number
  /** Data files its current rows are read from. */
  readonly dataFiles: number
  /** Data files small enough that the provider's compaction merges them. */
  readonly smallDataFiles: number
  readonly dataBytes: number
  /** Files listing rows of data files as deleted, read with them until compaction rewrites them. */
  readonly deleteFiles: number
  /** Rows kept in the catalog rather than in files, replaced ones included, until compaction. */
  readonly inlinedRows: number
  /** Commits still in the dataset's history: its versions and their maintenance. */
  readonly retainedSnapshots: number
  /** The columns the dataset is partitioned by, empty when it is not. */
  readonly partitionBy: readonly string[]
  readonly warnings: readonly DatasetStorageWarning[]
}

export interface DatasetStorageWarning {
  /**
   * `partitioned-small-dataset`: the dataset is partitioned below the size partitioning pays
   * off at. Each write then adds a file per partition it touches, and compaction merges files
   * only within one partition.
   */
  readonly code: "partitioned-small-dataset"
  readonly message: string
}
