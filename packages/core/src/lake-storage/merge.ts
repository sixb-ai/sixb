import type { DatasetDefinition, MergeChange } from "../datasets"
import { LakeConcurrencyError } from "./errors"
import type { DatasetProducer, DatasetRow, DatasetVersion, DatasetVersionRef } from "./types"

export interface BeginDatasetMergeInput {
  /** Stored definition for the keyed dataset whose latest version is captured by `beginMerge`. */
  readonly dataset: DatasetDefinition
  /** Optional caller guard checked against the same latest version captured by the session. */
  readonly expectedLatestVersionId?: string
  readonly producer?: DatasetProducer
  readonly inputs?: readonly DatasetVersionRef[]
}

export interface CommitDatasetMergeInput {
  readonly commitMessage?: string
  /** Create an addressable first version even without changes; reuse an existing version on no-op. */
  readonly createInitialVersion?: boolean
  /** Retry sequenced merges up to three times total; ignored when an explicit version guard is set. */
  readonly retryOnConflict?: boolean
  /** Checked before each attempt; a durable commit is never cancelled retroactively. */
  readonly signal?: AbortSignal
}

/** Providers retain their staging session throughout this bounded commit loop. */
export async function retryDatasetMergeCommit(
  merge: BeginDatasetMergeInput,
  commit: CommitDatasetMergeInput | undefined,
  run: (rebase: boolean) => Promise<DatasetMergeCommitResult>
): Promise<DatasetMergeCommitResult> {
  const attempts =
    commit?.retryOnConflict &&
    merge.dataset.sequenceBy !== undefined &&
    merge.expectedLatestVersionId === undefined
      ? 3
      : 1
  for (let attempt = 0; ; attempt += 1) {
    commit?.signal?.throwIfAborted()
    try {
      return await run(attempt > 0)
    } catch (error) {
      if (!(error instanceof LakeConcurrencyError) || attempts === 1) throw error
      if (attempt + 1 === attempts) {
        throw new LakeConcurrencyError(
          `[SixbLake] Dataset '${merge.dataset.id}' merge exhausted ${attempts} concurrency attempts. No changes from this operation were committed.`,
          { cause: error }
        )
      }
    }
  }
}

/**
 * A merge can be unchanged before the dataset has a first version, so its result carries the
 * version separately instead of extending `DatasetVersion` like ordinary write commits do.
 */
export type DatasetMergeCommitResult =
  | { readonly outcome: "created"; readonly version: DatasetVersion }
  | { readonly outcome: "unchanged"; readonly version: DatasetVersion | null }

export interface LakeMergeSession {
  /**
   * Stage ordered complete-row upserts and exact primary-key deletes. With sequenceBy, deletes
   * require a sequence, stale changes are ignored, and conflicting ties abort the whole merge.
   */
  writeChanges(
    changes:
      | Iterable<MergeChange<DatasetRow, DatasetRow>>
      | AsyncIterable<MergeChange<DatasetRow, DatasetRow>>
  ): Promise<void>
  /** Commit against the captured version; opt-in retries rebase sequenced changes on a fresh head. */
  commit(input?: CommitDatasetMergeInput): Promise<DatasetMergeCommitResult>
  abort(): Promise<void>
}
