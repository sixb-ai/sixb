import type { DatasetDefinition, DatasetSchema } from "../datasets"
import type { BeginDatasetMergeInput, LakeMergeSession } from "./merge"

export type DatasetWriteMode = "snapshot" | "append"
export type DatasetVersionMode = DatasetWriteMode | "merge" | "schema"

export type DatasetRow = Readonly<Record<string, unknown>>

export type LakeStandardId = "ducklake"

export interface LakeStandardDescriptor<TStandard extends LakeStandardId = LakeStandardId> {
  readonly id: TStandard
  readonly version?: string
}

export interface DatasetVersionRef {
  readonly datasetId: string
  readonly versionId: string
}

export interface DatasetProducer {
  readonly kind: "sync" | "pipeline"
  readonly id?: string
  readonly runId?: string
  readonly stepId?: string
}

export interface DatasetVersion {
  readonly datasetId: string
  readonly versionId: string
  readonly parentVersionId?: string
  readonly mode: DatasetVersionMode
  readonly createdAt: Date
  readonly schema: DatasetSchema
  readonly producer?: DatasetProducer
  readonly inputs?: readonly DatasetVersionRef[]
  readonly rowCount?: number
  readonly sizeBytes?: number
}

export interface DatasetLatestVersionSummary {
  readonly datasetId: string
  readonly versionId: string
  readonly mode: DatasetVersionMode
  readonly createdAt: Date
  readonly rowCount?: number
}

export interface DatasetCatalogState {
  readonly datasetId: string
  readonly materialized: boolean
  readonly latestVersion?: DatasetLatestVersionSummary | null
}

export interface BeginDatasetWriteInput {
  readonly dataset: DatasetDefinition
  readonly mode?: DatasetWriteMode
  readonly producer?: DatasetProducer
  readonly inputs?: readonly DatasetVersionRef[]
}

export interface ReadDatasetRowsInput {
  readonly datasetId: string
  /**
   * Pins an immutable physical row sequence. For an explicit version, providers must return the
   * same order across reads and reopen; `offset: N` is exactly the suffix starting at row N.
   */
  readonly versionId?: string
  /** Column projection must not alter the physical row order. */
  readonly columns?: readonly string[]
  readonly limit?: number
  readonly offset?: number
}

export interface CommitDatasetWriteInput {
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
}

export interface DatasetWriteCommitResult extends DatasetVersion {
  /**
   * Whether this operation created the returned version or reused the
   * unchanged latest version. When a latest version exists, providers must
   * report `unchanged` and reuse it for commits that cannot change visible
   * dataset content: a snapshot whose rows equal the latest visible rows
   * (order-insensitive, with equal duplicate counts), or an append of zero
   * rows. Without a latest version, an empty snapshot or append still creates
   * the first addressable dataset version.
   */
  readonly outcome: "created" | "unchanged"
}

export interface LakeWriteSession {
  writeRows(rows: Iterable<DatasetRow> | AsyncIterable<DatasetRow>): Promise<void>
  commit(input?: CommitDatasetWriteInput): Promise<DatasetWriteCommitResult>
  abort(): Promise<void>
}

export interface LakeStorage {
  readonly standard?: LakeStandardDescriptor

  /**
   * Read-only preflight for hosts that want to fail before serving traffic.
   *
   * Implementations must not create datasets, apply DDL, write rows, or commit
   * versions from this method. Missing persisted datasets should be treated as
   * compatible because createDataset remains the materialization path.
   */
  assertDatasetDefinitionsCompatible(definitions: readonly DatasetDefinition[]): Promise<void>

  createDataset(definition: DatasetDefinition): Promise<DatasetDefinition>
  getDataset(datasetId: string): Promise<DatasetDefinition | null>
  listDatasets(): Promise<readonly DatasetDefinition[]>

  /**
   * Bulk catalog-summary read for the dataset list view.
   *
   * Returns lightweight materialized + latest-version state for the requested
   * dataset ids using a bounded number of catalog calls, never a per-dataset
   * full version hydration or a count(*) over dataset contents. Row counts are
   * only populated when storage already knows them cheaply (such as Sixb commit
   * metadata); otherwise `rowCount` is omitted.
   */
  listDatasetCatalogState(datasetIds: readonly string[]): Promise<readonly DatasetCatalogState[]>

  listVersions(datasetId: string, limit?: number): Promise<readonly DatasetVersion[]>

  beginWrite(input: BeginDatasetWriteInput): Promise<LakeWriteSession>
  beginMerge(input: BeginDatasetMergeInput): Promise<LakeMergeSession>

  getLatestVersion(datasetId: string): Promise<DatasetVersion | null>
  getVersion(datasetId: string, versionId: string): Promise<DatasetVersion | null>
  /** Explicit immutable-version reads have stable physical order and stable offset semantics. */
  readRows(input: ReadDatasetRowsInput): AsyncIterable<DatasetRow>

  /** Release external resources. Optional: a provider that owns none omits it. */
  close?(): void | Promise<void>
}
