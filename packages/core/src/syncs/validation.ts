import type { DatasetDefinition } from "../datasets"
import type { PipelineDefinition } from "../pipelines"
import type { TelemetryProjectionDefinition } from "../projections"
import { SyncValidationError } from "./errors"
import type { SyncDefinition } from "./types"

interface DatasetWriter {
  readonly datasetId: string
  readonly label: string
}

export function validateKeyedDatasetWriterTopology(input: {
  readonly datasetsById: ReadonlyMap<string, DatasetDefinition>
  readonly syncs: readonly SyncDefinition[]
  readonly pipelines: readonly PipelineDefinition[]
}): void {
  for (const sync of input.syncs) {
    const dataset = input.datasetsById.get(sync.target.dataset.id)
    if (sync.config.mode === "merge" && dataset?.primaryKey === undefined) {
      throw new SyncValidationError(
        `[Sixb] Merge sync '${sync.id}' targets dataset '${sync.target.dataset.id}', which must define a primaryKey.`
      )
    }
  }

  const firstWriterByDataset = new Map<string, DatasetWriter>()
  for (const writer of datasetWriters(input.syncs, input.pipelines)) {
    const dataset = input.datasetsById.get(writer.datasetId)
    if (dataset?.primaryKey === undefined) continue

    const first = firstWriterByDataset.get(writer.datasetId)
    if (!first) {
      firstWriterByDataset.set(writer.datasetId, writer)
      continue
    }

    throw new SyncValidationError(
      `[Sixb] Keyed dataset '${writer.datasetId}' has multiple registered writers: ${first.label} and ${writer.label}. V1 allows one writer per keyed dataset.`
    )
  }
}

export function validateMergeSyncProjectionSafety(input: {
  readonly syncs: readonly SyncDefinition[]
  readonly telemetryProjections: readonly TelemetryProjectionDefinition[]
}): void {
  const mergeSyncByDataset = new Map(
    input.syncs
      .filter((sync) => sync.config.mode === "merge")
      .map((sync) => [sync.target.dataset.id, sync] as const)
  )

  for (const projection of input.telemetryProjections) {
    const sync = mergeSyncByDataset.get(projection.datasetId)
    if (!sync) continue
    throw new SyncValidationError(
      `[Sixb] Telemetry projection '${projection.id}' cannot read merge-written dataset '${projection.datasetId}' from sync '${sync.id}'. V1 merge syncs support object and link replacement projections only.`
    )
  }
}

function* datasetWriters(
  syncs: readonly SyncDefinition[],
  pipelines: readonly PipelineDefinition[]
): Iterable<DatasetWriter> {
  for (const sync of syncs) {
    yield { datasetId: sync.target.dataset.id, label: `sync '${sync.id}'` }
  }
  for (const pipeline of pipelines) {
    for (const node of pipeline.graph.nodes) {
      yield {
        datasetId: node.step.output.id,
        label: `pipeline '${pipeline.id}' step '${node.step.id}'`,
      }
    }
  }
}
