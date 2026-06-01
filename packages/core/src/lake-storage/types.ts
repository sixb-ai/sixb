import type { DatasetDefinition, DatasetSchema } from "../datasets"

export type DatasetWriteMode = "snapshot" | "append"
export type DatasetVersionMode = DatasetWriteMode | "schema"

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
  readonly versionId?: string
  readonly columns?: readonly string[]
  readonly limit?: number
  readonly offset?: number
}

export interface CommitDatasetWriteInput {
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
}

export interface LakeWriteSession {
  writeRows(rows: Iterable<DatasetRow> | AsyncIterable<DatasetRow>): Promise<void>
  commit(input?: CommitDatasetWriteInput): Promise<DatasetVersion>
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

  getLatestVersion(datasetId: string): Promise<DatasetVersion | null>
  getVersion(datasetId: string, versionId: string): Promise<DatasetVersion | null>
  readRows(input: ReadDatasetRowsInput): AsyncIterable<DatasetRow>
}
