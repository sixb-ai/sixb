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
import type { DatasetVersionMarkings } from "../security/dataset-version-markings"
import { missingClearanceRedactions } from "../security/redactions"
import type { Redactions } from "../security/types"
import type { MergeChange } from "./changes"
import {
  type DatasetLineage,
  type DatasetLineageInput,
  datasetLineageDepth,
  visibleProducer,
  walkDatasetLineage,
} from "./lineage"
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

/**
 * A dataset version as {@link DatasetsRuntime} returns it: without its column lineage, which names
 * upstream datasets, and with its producer and inputs reduced to what the reader may see.
 */
export type VisibleDatasetVersion = Omit<DatasetVersion, "lineage">

export interface DatasetRows {
  /** The version read, as {@link DatasetsRuntime.getVersion} returns it. */
  readonly version: VisibleDatasetVersion
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
   * The dataset's versions, newest first, as {@link getVersion} returns each. Returns at most
   * `limit` versions.
   */
  listVersions(
    dataset: DatasetDefinition,
    input?: { readonly limit?: number }
  ): Promise<readonly VisibleDatasetVersion[]>
  /**
   * One version, as the reader may see it: its producer names its definition and run only to a
   * reader who may view those runs, it lists only the inputs whose dataset the reader may view,
   * and it leaves out its column lineage. Returns null when the version does not exist.
   */
  getVersion(dataset: DatasetDefinition, versionId: string): Promise<VisibleDatasetVersion | null>
  /**
   * Read rows of one version. Returns null when the dataset has no version yet or the requested
   * version does not exist.
   */
  readRows(dataset: DatasetDefinition, input?: DatasetReadRowsInput): Promise<DatasetRows | null>
  /**
   * Walk the versions one version is computed from. Returns null when the reader cannot view the
   * dataset, it has no version yet, or the requested version does not exist.
   */
  lineage(dataset: DatasetDefinition, input?: DatasetLineageInput): Promise<DatasetLineage | null>
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
    async listVersions(dataset, input = {}) {
      assertAuthorized(runtime, { kind: "dataset.view", datasetId: dataset.id })
      const registered = source.getById(dataset.id)
      if (!registered) throw new Error(`[Sixb] Dataset '${dataset.id}' is not registered.`)

      const versions = await lakeStorage.listVersions(registered.id, input.limit)
      return versions.map((version) => readerVersion(runtime, version))
    },
    async getVersion(dataset, versionId) {
      assertAuthorized(runtime, { kind: "dataset.view", datasetId: dataset.id })
      const registered = source.getById(dataset.id)
      if (!registered) throw new Error(`[Sixb] Dataset '${dataset.id}' is not registered.`)

      const version = await lakeStorage.getVersion(registered.id, versionId)
      return version && readerVersion(runtime, version)
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

      const redacted = redactedColumns(
        version,
        versionMarkings,
        assertRuntimeAuthorizationBound(runtime)
      )
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
        version: readerVersion(runtime, version),
        columns,
        ...(redacted.size > 0 ? { redactions: missingClearanceRedactions(redacted) } : {}),
        rows,
      }
    },
    async lineage(dataset, input = {}) {
      const depth = datasetLineageDepth(input.depth)
      if (!allowed(dataset.id)) return null

      const registered = source.getById(dataset.id)
      if (!registered) throw new Error(`[Sixb] Dataset '${dataset.id}' is not registered.`)
      const version =
        input.versionId === undefined
          ? await lakeStorage.getLatestVersion(registered.id)
          : await lakeStorage.getVersion(registered.id, input.versionId)
      if (!version) return null

      return walkDatasetLineage(runtime, lakeStorage, version, depth)
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

/**
 * A version as the reader may see it, by the rules dataset lineage applies: a producer whose runs
 * the reader may not view gives only its kind, and an input whose dataset it may not view is left
 * out. Its column lineage, which names upstream datasets, is left out too.
 */
function readerVersion(
  runtime: SixbRuntimeContext,
  version: DatasetVersion
): VisibleDatasetVersion {
  const { lineage: _lineage, producer, inputs, ...rest } = version

  return {
    ...rest,
    ...(producer === undefined ? {} : { producer: visibleProducer(runtime, producer) }),
    ...(inputs === undefined
      ? {}
      : {
          inputs: inputs.filter((input) =>
            isRuntimeAllowed(runtime, { kind: "dataset.view", datasetId: input.datasetId })
          ),
        }),
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
 * Columns of the version the reader cannot read. Trusted code reads every column, a principal reads
 * what its roles clear, and any other authority is cleared for nothing.
 *
 * No version carries a marking the project does not declare on a column, so a reader cleared for
 * every declared marking (all readers, when none is declared) reads every column without
 * classifying the version.
 */
function redactedColumns(
  version: DatasetVersion,
  versionMarkings: DatasetVersionMarkings,
  authority: ReturnType<typeof assertRuntimeAuthorizationBound>
): ReadonlySet<string> {
  if (authority.type === "unrestricted") return new Set()
  const clearances =
    authority.type === "principal" ? (authority.context.clearances ?? new Set()) : new Set()
  if ([...versionMarkings.everyMarking()].every((id) => clearances.has(id))) return new Set()

  const { columns } = versionMarkings.classify(version)
  return new Set(
    [...columns]
      .filter(([, columnMarkings]) => [...columnMarkings].some((id) => !clearances.has(id)))
      .map(([column]) => column)
  )
}

async function* emptyRows(rows: AsyncIterable<DatasetRow>): AsyncIterable<DatasetRow> {
  for await (const _row of rows) yield {}
}
