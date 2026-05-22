import {
  type DatasetDefinition,
  type DatasetRow,
  getDatasetRowValidationError,
  ObjectNotFoundError,
  type ObjectProjectionDefinition,
  objectService,
} from "@pario/core"
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

interface CollectedObjectRow {
  readonly properties: Record<string, unknown>
  readonly primaryValue: unknown
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
  const batch: CollectedObjectRow[] = []
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

    const succeededRows: CollectedObjectRow[] = []
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
  })) {
    throwIfAborted(signal)
    counters.rowsProcessed += 1

    const validationError = getDatasetRowValidationError(row, dataset)
    if (validationError) {
      counters.rowsSkipped += 1
      rememberError(validationError)
      continue
    }

    const properties = collectProperties(projection, row)
    const primaryValue = properties[primaryPropertyId]
    if (isBlank(primaryValue)) {
      counters.rowsSkipped += 1
      continue
    }

    batch.push({ properties, primaryValue })
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

function collectProperties(
  projection: ObjectProjectionDefinition,
  row: DatasetRow
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const [propertyId, columnName] of Object.entries(projection.properties)) {
    const value = row[columnName]
    if (value !== null && value !== undefined) {
      properties[propertyId] = value
    }
  }
  return properties
}

async function upsertForeignKeyLinks(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: ObjectProjectionDefinition
  readonly rows: readonly CollectedObjectRow[]
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
