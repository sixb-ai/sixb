import { assertPrivileged, isAllowed } from "../authorization"
import type { BlobStorage } from "../blob-storage"
import type { ExecutionContext } from "../execution"
import type { DatasetMergeCommitResult } from "../lake-storage/merge"
import { getDatasetPrimaryKeyColumns } from "../lake-storage/merge-validation"
import type { DatasetRow, LakeStorage } from "../lake-storage/types"
import type { SixbRuntimeContext } from "../runtime/types"
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

export interface DatasetsRuntime {
  list(): readonly DatasetDefinition[]
  getById(datasetId: string): DatasetDefinition | null
  ingest(dataset: DatasetDefinition, input: DatasetIngestInput): Promise<DatasetIngestResult>
}

export function createDatasetsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  source: Pick<DatasetsRuntime, "list" | "getById">,
  lakeStorage: LakeStorage,
  blobStorage: Pick<BlobStorage, "stat">
): DatasetsRuntime {
  const allowed = (datasetId: string) =>
    isAllowed(runtime.authorization, { kind: "dataset.view", datasetId })

  return {
    list: () => source.list().filter((dataset) => allowed(dataset.id)),
    getById: (datasetId) => {
      const dataset = source.getById(datasetId)
      return dataset && allowed(datasetId) ? dataset : null
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
