import type { DatasetDefinition, MergeChange } from "../datasets"
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
}

/**
 * A merge can be unchanged before the dataset has a first version, so its result carries the
 * version separately instead of extending `DatasetVersion` like ordinary write commits do.
 */
export type DatasetMergeCommitResult =
  | { readonly outcome: "created"; readonly version: DatasetVersion }
  | { readonly outcome: "unchanged"; readonly version: DatasetVersion | null }

export interface LakeMergeSession {
  /** Stage ordered complete-row upserts and exact primary-key deletes. */
  writeChanges(
    changes:
      | Iterable<MergeChange<DatasetRow, DatasetRow>>
      | AsyncIterable<MergeChange<DatasetRow, DatasetRow>>
  ): Promise<void>
  /** Commit only if the latest version still matches the version captured when the session began. */
  commit(input?: CommitDatasetMergeInput): Promise<DatasetMergeCommitResult>
  abort(): Promise<void>
}
