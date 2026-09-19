import {
  type DatasetDefinition,
  type DatasetRow,
  type LinkProjectionDefinition,
  type ObjectProjectionDefinition,
  stableJsonStringify,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type {
  ProjectionSourceBase,
  ProjectionSourceDeletion,
  ProjectionSourceEntry,
} from "@sixb/core/internal/materialization"
import { getOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import type { DatasetChanges } from "@sixb/core/lake-storage"
import { buildObjectProjectionPlan } from "./object-projection-plan"
import { mapLinkProjectionRow } from "./run-link-projection"
import { mapObjectProjectionRow, objectProjectionReadColumns } from "./run-object-projection"
import type { ClaimedProjectionExecution, ProjectionWorkerContext } from "./types"
import { throwIfAborted } from "./utils"

interface IncrementalReplacement {
  readonly base: ProjectionSourceBase
  readonly entries: AsyncIterable<ProjectionSourceEntry | ProjectionSourceDeletion>
  close(): Promise<void>
}

/** Full reads remain the fallback when either pinned state cannot identify complete roots. */
export async function prepareIncrementalReplacement(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: ObjectProjectionDefinition | LinkProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly execution: ClaimedProjectionExecution
  readonly expectedRows?: number
  readonly signal: AbortSignal
}): Promise<IncrementalReplacement | null> {
  const { runtime, projection, dataset, execution, signal } = input
  // A full-read attempt retains its physical progress floor across retries. Delta progress has
  // its own counter so a delta retry may safely fall back to a complete read of fewer rows.
  if (!runtime.lakeStorage.readChanges || execution.run.progress.sourceRowsRead > 0) return null
  const active = await getOntologyMutationRuntime(runtime).getProjectionSource?.({
    projectionId: projection.id,
  })
  const identity = execution.run.identity
  if (
    !active?.lastCommitId ||
    active.datasetVersion.datasetId !== identity.datasetVersion.datasetId ||
    active.projectionRevision !== identity.projectionRevision ||
    active.ownershipHash !== identity.ownershipHash ||
    active.ontologyRevision !== identity.ontologyRevision
  )
    return null

  let columns: readonly string[]
  let keyColumns: readonly string[]
  let mapRow: (row: DatasetRow) => ProjectionSourceEntry | null
  if (projection._tag === "ObjectProjectionDefinition") {
    const primaryPropertyId = runtime.ontology.getPrimaryPropertyId(projection.objectTypeId)
    const primaryColumn = projection.properties[primaryPropertyId]
    if (!primaryColumn) return null
    columns = objectProjectionReadColumns(projection)
    keyColumns = [primaryColumn]
    const plan = buildObjectProjectionPlan({
      ontology: runtime.ontology,
      projection,
      dataset,
      primaryPropertyId,
      correlation: { runId: execution.run.id, versionId: identity.datasetVersion.versionId },
    })
    mapRow = (row) => mapObjectProjectionRow(plan, row)
  } else {
    columns = [...new Set([projection.sourceField, projection.targetField])]
    keyColumns = columns
    mapRow = (row) => mapLinkProjectionRow(projection, dataset, row)
  }
  throwIfAborted(signal)
  const delta = await runtime.lakeStorage.readChanges({
    datasetId: identity.datasetVersion.datasetId,
    fromVersionId: active.datasetVersion.versionId,
    toVersionId: identity.datasetVersion.versionId,
    keyColumns,
    columns,
    signal,
  })
  if (!delta) return null
  try {
    for (const count of [delta.fromRowCount, delta.toRowCount, delta.changeCount]) {
      if (!Number.isSafeInteger(count) || count < 0)
        throw inconsistent("Invalid pinned change count.")
    }
    if (input.expectedRows !== undefined && delta.toRowCount !== input.expectedRows) {
      throw inconsistent("Change reader row count differs from the pinned target version.")
    }
    return {
      base: { materializationId: active.materializationId, lastCommitId: active.lastCommitId },
      entries: mapChanges(delta, mapRow, runtime, execution, signal),
      close: () => delta.close(),
    }
  } catch (error) {
    await delta.close()
    throw error
  }
}

async function* mapChanges(
  delta: DatasetChanges,
  mapRow: (row: DatasetRow) => ProjectionSourceEntry | null,
  runtime: ProjectionWorkerContext,
  execution: ClaimedProjectionExecution,
  signal: AbortSignal
): AsyncIterable<ProjectionSourceEntry | ProjectionSourceDeletion> {
  let read = 0
  let reported = execution.run.progress.sourceChangesRead ?? 0
  let hasReported = execution.run.progress.sourceChangesRead !== undefined
  const flush = async () => {
    if (hasReported && read <= reported) return
    const run = await runtime.projectionRunsStorage.update({
      projectId: runtime.projectId,
      id: execution.run.id,
      executionToken: execution.execution.executionToken,
      identity: execution.run.identity,
      progress: { sourceChangesRead: Math.max(read, reported) },
    })
    reported = run.progress.sourceChangesRead ?? 0
    hasReported = true
  }
  try {
    for await (const change of delta.changes) {
      throwIfAborted(signal)
      if (++read > delta.changeCount || (!change.before && !change.after)) {
        throw inconsistent("Change reader returned an invalid or excessive record.")
      }
      const before = change.before ? mapRow(change.before) : null
      const after = change.after ? mapRow(change.after) : null
      if (read % 500 === 0) await flush()
      if (stableJsonStringify(before) === stableJsonStringify(after)) continue
      if (
        before &&
        (!after || stableJsonStringify(before.root) !== stableJsonStringify(after.root))
      ) {
        yield { root: before.root, deleted: true }
      }
      if (after) yield after
    }
    if (read !== delta.changeCount)
      throw inconsistent(`Change reader reached EOF after ${read} of ${delta.changeCount} records.`)
  } finally {
    await flush()
  }
}

function inconsistent(message: string) {
  return createSixbError("dataset.version_read_inconsistent", `[SixbProjectionWorker] ${message}`)
}
