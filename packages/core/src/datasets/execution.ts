import {
  AuthorizationError,
  assertAuthorized,
  assertPrivileged,
  assertRuntimeAuthorizationBound,
  isRuntimeAllowed,
} from "../authorization"
import type { BlobStorage } from "../blob-storage"
import type { ExecutionContext } from "../execution"
import { resolveRuntimeAuthorizationForProject } from "../execution/authorization"
import type { DatasetMergeCommitResult } from "../lake-storage/merge"
import { getDatasetPrimaryKeyColumns } from "../lake-storage/merge-validation"
import type {
  DatasetCatalogState,
  DatasetRow,
  DatasetVersion,
  LakeStorage,
} from "../lake-storage/types"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  DatasetVersionMarkings,
  VersionClassification,
} from "../security/dataset-version-markings"
import { missingClearanceRedactions } from "../security/redactions"
import type { Redactions } from "../security/types"
import type { MergeChange } from "./changes"
import type { DatasetDefinition } from "./types"
import { writeDataset } from "./write"

export interface DatasetIngestInput {
  readonly changes:
    | Iterable<MergeChange<DatasetRow, DatasetRow>>
    | AsyncIterable<MergeChange<DatasetRow, DatasetRow>>
  readonly signal?: AbortSignal
}

/** Source commit result; downstream pipelines and projections run asynchronously. */
export type DatasetIngestResult = DatasetMergeCommitResult & { readonly rowsRead: number }

export interface DatasetReadRowsInput {
  /** Defaults to the latest version. */
  readonly versionId?: string
  /** Defaults to every column of the version, in schema order. */
  readonly columns?: readonly string[]
  readonly limit?: number
  readonly offset?: number
  readonly signal?: AbortSignal
}

export interface DatasetRows {
  readonly version: DatasetVersion
  /** Columns each row holds. Redacted columns are left out. */
  readonly columns: readonly string[]
  /**
   * Every column of the version the reader cannot read, whether or not it was requested. Absent
   * when the reader can read every column.
   */
  readonly redactions?: Redactions
  readonly rows: AsyncIterable<DatasetRow>
}

export interface DatasetsRuntime {
  list(): readonly DatasetDefinition[]
  getById(datasetId: string): DatasetDefinition | null
  /**
   * Read rows of one version. Returns null when the dataset has no version yet or the requested
   * version does not exist. Refused when the reader is not cleared for a marking that decided
   * which rows the version holds: which rows it holds, and how many, would reveal it.
   */
  readRows(dataset: DatasetDefinition, input?: DatasetReadRowsInput): Promise<DatasetRows | null>
  /**
   * Versions of the dataset, newest first. `rowCount` and `sizeBytes` are left out of a version
   * whose rows the reader cannot read, as `readRows` refuses them.
   */
  listVersions(
    dataset: DatasetDefinition,
    input?: { readonly limit?: number }
  ): Promise<readonly DatasetVersion[]>
  /** One version, described like `listVersions` does. Null when it does not exist. */
  getVersion(dataset: DatasetDefinition, versionId: string): Promise<DatasetVersion | null>
  /**
   * Whether each dataset was materialized, and a summary of its latest version, whose `rowCount`
   * is left out like `listVersions` does.
   */
  listCatalogState(datasets: readonly DatasetDefinition[]): Promise<readonly DatasetCatalogState[]>
  ingest(dataset: DatasetDefinition, input: DatasetIngestInput): Promise<DatasetIngestResult>
}

export function createDatasetsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  source: Pick<DatasetsRuntime, "list" | "getById">,
  lakeStorage: LakeStorage,
  blobStorage: Pick<BlobStorage, "stat">,
  versionMarkings: DatasetVersionMarkings
): DatasetsRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const allowed = (datasetId: string) =>
    isRuntimeAllowed(runtime, { kind: "dataset.view", datasetId })

  /** The reader's clearances; undefined for trusted code, which reads everything. */
  const readerClearances = (): ReadonlySet<string> | undefined => {
    const authority = assertRuntimeAuthorizationBound(runtime)
    if (authority.type === "unrestricted") return undefined
    return authority.type === "principal" ? (authority.context.clearances ?? new Set()) : new Set()
  }
  /**
   * The version classified for this reader; undefined when the reader is cleared for every
   * marking it may carry. No version carries a marking the project does not declare on a column,
   * so a reader cleared for every declared marking (all readers, when none is declared) reads
   * the version without classifying it.
   */
  const classifyForReader = (version: DatasetVersion): ReaderClassification | undefined => {
    const clearances = readerClearances()
    if (!clearances) return undefined
    if ([...versionMarkings.everyMarking()].every((id) => clearances.has(id))) return undefined
    return { classification: versionMarkings.classify(version), clearances }
  }
  /** Without its row count and size when the reader cannot read its rows. */
  const describeVersion = (version: DatasetVersion): DatasetVersion => {
    if (missingRowMarking(classifyForReader(version)) === undefined) return version
    const { rowCount: _rowCount, sizeBytes: _sizeBytes, ...described } = version
    return described
  }
  const assertViewable = (dataset: DatasetDefinition): DatasetDefinition => {
    assertAuthorized(runtime, { kind: "dataset.view", datasetId: dataset.id })
    const registered = source.getById(dataset.id)
    if (!registered) throw new Error(`[Sixb] Dataset '${dataset.id}' is not registered.`)
    return registered
  }

  return {
    list: () =>
      authority.type === "denied" || authority.type === "delegated"
        ? []
        : source.list().filter((dataset) => allowed(dataset.id)),
    getById: (datasetId) => {
      if (authority.type === "denied" || authority.type === "delegated") return null
      const dataset = source.getById(datasetId)
      return dataset && allowed(datasetId) ? dataset : null
    },
    async readRows(dataset, input = {}) {
      const registered = assertViewable(dataset)
      const version =
        input.versionId === undefined
          ? await lakeStorage.getLatestVersion(registered.id)
          : await lakeStorage.getVersion(registered.id, input.versionId)
      if (!version) return null

      const classified = classifyForReader(version)
      assertRowsReadable(version, classified)
      const redacted = redactedColumns(classified)
      const selected = selectColumns(version, input.columns)
      const columns = selected.filter((column) => !redacted.has(column))
      const read = (readColumns: readonly string[] | undefined) =>
        lakeStorage.readRows({
          datasetId: registered.id,
          versionId: version.versionId,
          columns: readColumns,
          limit: input.limit,
          offset: input.offset,
          signal: input.signal,
        })

      // Redacted columns are not read. A provider reads every column when given none, so a page
      // made only of redacted columns reads one of them to count its rows and returns them empty.
      const rows =
        columns.length === selected.length
          ? read(input.columns)
          : columns.length > 0
            ? read(columns)
            : emptyRows(read(selected.slice(0, 1)))
      return {
        version,
        columns,
        ...(redacted.size > 0 ? { redactions: missingClearanceRedactions(redacted) } : {}),
        rows,
      }
    },
    async listVersions(dataset, input = {}) {
      const registered = assertViewable(dataset)
      const versions = await lakeStorage.listVersions(registered.id, input.limit)
      return versions.map(describeVersion)
    },
    async getVersion(dataset, versionId) {
      const registered = assertViewable(dataset)
      const version = await lakeStorage.getVersion(registered.id, versionId)
      return version && describeVersion(version)
    },
    async listCatalogState(datasets) {
      const registered = datasets.map(assertViewable)
      const states = await lakeStorage.listDatasetCatalogState(registered.map(({ id }) => id))
      const clearances = readerClearances()
      if (!clearances || [...versionMarkings.everyMarking()].every((id) => clearances.has(id))) {
        return states
      }
      // A summary records no lineage: read the versions whose row count the reader would see.
      return Promise.all(
        states.map(async (state) => {
          const latest = state.latestVersion
          if (latest?.rowCount === undefined) return state
          const version = await lakeStorage.getVersion(latest.datasetId, latest.versionId)
          if (version && describeVersion(version).rowCount !== undefined) return state
          const { rowCount: _rowCount, ...summary } = latest
          return { ...state, latestVersion: summary }
        })
      )
    },
    async ingest(dataset, input) {
      assertPrivileged(runtime, "datasets.ingest")
      const registered = source.getById(dataset.id)
      if (!registered) throw new Error(`[Sixb] Dataset '${dataset.id}' is not registered.`)
      if (getDatasetPrimaryKeyColumns(registered) === null) {
        throw new Error(`[Sixb] Dataset '${dataset.id}' must define a primaryKey before ingestion.`)
      }
      if (typeof lakeStorage.beginMerge !== "function") {
        throw new Error("[Sixb] Dataset ingestion requires a lake provider with merge support.")
      }
      const producer = { kind: "ingest" as const, id: execution.id }
      const result = await writeDataset({
        lakeStorage,
        blobStorage,
        dataset: registered,
        mode: "merge",
        signal: input.signal ?? new AbortController().signal,
        producer,
        readValues: async () =>
          (async function* () {
            for await (const value of input.changes) yield { value }
          })(),
      })
      if (result.outcome === "created") {
        await runtime.events.emit(
          {
            events: [
              {
                type: "dataset.version.committed",
                payload: {
                  datasetId: registered.id,
                  versionId: result.version.versionId,
                  createdAt: result.version.createdAt.toISOString(),
                  producer,
                },
              },
            ],
            correlationId: execution.correlationId,
          },
          { source: "SixbDatasets" }
        )
      }
      return result
    },
  }
}

/** Requested columns, or every column of the version. Like the lake, an empty list means all. */
function selectColumns(version: DatasetVersion, requested: readonly string[] | undefined) {
  const available = version.schema.columns.map((column) => column.name)
  if (requested === undefined || requested.length === 0) return available
  for (const column of requested) {
    if (!available.includes(column)) {
      throw new Error(
        `[Sixb] Dataset '${version.datasetId}' does not have column '${column}' at version '${version.versionId}'.`
      )
    }
  }
  return [...requested]
}

/** A version classified for a reader that some of its markings may affect. */
interface ReaderClassification {
  readonly classification: VersionClassification
  readonly clearances: ReadonlySet<string>
}

/** Columns of the version the reader cannot read. */
function redactedColumns(classified: ReaderClassification | undefined): ReadonlySet<string> {
  if (!classified) return new Set()
  const { classification, clearances } = classified
  return new Set(
    [...classification.columns]
      .filter(([, columnMarkings]) => [...columnMarkings].some((id) => !clearances.has(id)))
      .map(([column]) => column)
  )
}

/** A marking that decided which rows the version holds, which the reader is not cleared for. */
function missingRowMarking(classified: ReaderClassification | undefined): string | undefined {
  if (!classified) return undefined
  return [...classified.classification.rows].find((id) => !classified.clearances.has(id))
}

/**
 * Every column of such a version is redacted, but its rows would still say how many rows the
 * filter kept, and which: `WHERE amount > 100` reveals amounts through `id` alone.
 */
function assertRowsReadable(
  version: DatasetVersion,
  classified: ReaderClassification | undefined
): void {
  const marking = missingRowMarking(classified)
  if (marking === undefined) return
  throw new AuthorizationError(
    `clearance:marking:${marking}`,
    `[Sixb] Cannot read the rows of version '${version.versionId}' of dataset '${version.datasetId}': which rows it holds was decided by columns that require clearance for marking '${marking}'.`
  )
}

async function* emptyRows(rows: AsyncIterable<DatasetRow>): AsyncIterable<DatasetRow> {
  for await (const _row of rows) yield {}
}
