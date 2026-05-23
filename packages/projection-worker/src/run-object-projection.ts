import {
  type DatasetDefinition,
  ObjectNotFoundError,
  type ObjectProjectionDefinition,
  objectService,
} from "@sixb/core"
import {
  buildObjectProjectionPlan,
  type ProjectedObjectRow,
  projectObjectRow,
} from "./object-projection-plan"
import type {
  ProjectionExecutionResult,
  ProjectionProgressReporter,
  ProjectionWorkerContext,
} from "./types"
import {
  createZeroCounters,
  errorMessage,
  isBlank,
  snapshotCounters,
  throwIfAborted,
} from "./utils"

interface RunObjectProjectionInput {
  readonly runtime: ProjectionWorkerContext
  readonly projection: ObjectProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly versionId: string
  readonly signal: AbortSignal
  readonly batchSize: number
  readonly onProgress?: ProjectionProgressReporter
}

interface ForeignKeyLinkItem {
  readonly objectTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly target: {
    readonly targetTypeId: string
    readonly targetId: string
  }
}

export async function runObjectProjection(
  input: RunObjectProjectionInput
): Promise<ProjectionExecutionResult> {
  const { runtime, projection, dataset, versionId, signal, batchSize, onProgress } = input
  const counters = createZeroCounters()
  const primaryPropertyId = runtime.ontology.getPrimaryPropertyId(projection.objectTypeId)
  const projectionPlan = buildObjectProjectionPlan({
    ontology: runtime.ontology,
    projection,
    dataset,
    primaryPropertyId,
  })
  const batch: ProjectedObjectRow[] = []
  let firstErrorMessage: string | undefined

  const rememberError = (message: string): void => {
    firstErrorMessage ??= message
  }

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) {
      return
    }

    const rows = batch.splice(0, batch.length)
    const batchResults = await objectService.upsertObjectBatch(
      runtime,
      projection.objectTypeId,
      rows.map((row) => ({ properties: row.properties }))
    )

    const succeededRows: ProjectedObjectRow[] = []
    for (let index = 0; index < rows.length; index += 1) {
      const result = batchResults[index]
      const row = rows[index]!
      if (result?.ok) {
        counters.objectsUpserted += 1
        succeededRows.push(row)
        continue
      }

      counters.rowsSkipped += 1
      rememberError(
        `Failed to upsert object '${String(row.primaryValue)}': ${errorMessage(result?.error)}`
      )
    }

    await upsertForeignKeyLinks({
      runtime,
      projection,
      rows: succeededRows,
      counters,
      rememberError,
    })

    await onProgress?.(snapshotCounters(counters))
  }

  for await (const row of runtime.lakeStorage.readRows({
    datasetId: projection.datasetId,
    versionId,
    columns: objectProjectionReadColumns(projection),
  })) {
    throwIfAborted(signal)
    counters.rowsProcessed += 1

    const projected = projectObjectRow(projectionPlan, row)
    if (!projected.ok) {
      counters.rowsSkipped += 1
      rememberError(projected.errorMessage)
      continue
    }

    if (isBlank(projected.row.primaryValue)) {
      counters.rowsSkipped += 1
      continue
    }

    batch.push(projected.row)
    if (batch.length >= batchSize) {
      await flushBatch()
    }
  }

  throwIfAborted(signal)
  await flushBatch()
  throwIfAborted(signal)
  await onProgress?.(snapshotCounters(counters))

  return {
    ...snapshotCounters(counters),
    firstErrorMessage,
  }
}

function objectProjectionReadColumns(projection: ObjectProjectionDefinition): readonly string[] {
  return [...new Set(Object.values(projection.properties))]
}

async function upsertForeignKeyLinks(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: ObjectProjectionDefinition
  readonly rows: readonly ProjectedObjectRow[]
  readonly counters: {
    linksUpserted: number
  }
  readonly rememberError: (message: string) => void
}): Promise<void> {
  const { runtime, projection, rows, counters, rememberError } = input
  const descriptors = Object.values(projection.links)
  if (descriptors.length === 0 || rows.length === 0) {
    return
  }

  const linkItems: ForeignKeyLinkItem[] = []
  for (const row of rows) {
    for (const descriptor of descriptors) {
      const fkValue = row.properties[descriptor.sourcePropertyId]
      if (isBlank(fkValue)) {
        continue
      }

      linkItems.push({
        objectTypeId: projection.objectTypeId,
        sourceId: String(row.primaryValue),
        linkId: descriptor.linkId,
        target: {
          targetTypeId: descriptor.targetObjectTypeId,
          targetId: String(fkValue),
        },
      })
    }
  }

  if (linkItems.length === 0) {
    return
  }

  const linkResults = await objectService.upsertLinkBatch(runtime, linkItems)
  for (let index = 0; index < linkResults.length; index += 1) {
    const result = linkResults[index]
    if (result?.ok) {
      counters.linksUpserted += 1
    } else if (!(result?.error instanceof ObjectNotFoundError)) {
      rememberError(errorMessage(result?.error))
    }
  }
}
