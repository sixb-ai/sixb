import {
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
import type { DatasetRow, DatasetVersion, LakeStorage } from "../lake-storage/types"
import type { SixbRuntimeContext } from "../runtime/types"
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
   * Every column of the dataset the reader cannot read, whether or not it was requested. Absent
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
   * version does not exist.
   */
  readRows(dataset: DatasetDefinition, input?: DatasetReadRowsInput): Promise<DatasetRows | null>
  ingest(dataset: DatasetDefinition, input: DatasetIngestInput): Promise<DatasetIngestResult>
}

export function createDatasetsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  source: Pick<DatasetsRuntime, "list" | "getById">,
  lakeStorage: LakeStorage,
  blobStorage: Pick<BlobStorage, "stat">
): DatasetsRuntime {
  const authority = resolveRuntimeAuthorizationForProject(runtime)
  const allowed = (datasetId: string) =>
    isRuntimeAllowed(runtime, { kind: "dataset.view", datasetId })

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
      assertAuthorized(runtime, { kind: "dataset.view", datasetId: dataset.id })
      const registered = source.getById(dataset.id)
      if (!registered) throw new Error(`[Sixb] Dataset '${dataset.id}' is not registered.`)
      const version =
        input.versionId === undefined
          ? await lakeStorage.getLatestVersion(registered.id)
          : await lakeStorage.getVersion(registered.id, input.versionId)
      if (!version) return null

      const redacted = redactedColumns(registered, assertRuntimeAuthorizationBound(runtime))
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

/**
 * Columns the reader cannot read. Trusted code reads every column, a principal reads what its roles
 * clear, and any other authority is cleared for nothing.
 */
function redactedColumns(
  dataset: DatasetDefinition,
  authority: ReturnType<typeof assertRuntimeAuthorizationBound>
): ReadonlySet<string> {
  if (authority.type === "unrestricted") return new Set()
  const clearances =
    authority.type === "principal" ? (authority.context.clearances ?? new Set()) : new Set()
  return new Set(
    dataset.schema.columns
      .filter((column) => column.markings?.some((markingId) => !clearances.has(markingId)))
      .map((column) => column.name)
  )
}

async function* emptyRows(rows: AsyncIterable<DatasetRow>): AsyncIterable<DatasetRow> {
  for await (const _row of rows) yield {}
}
