import {
  type DatasetDefinition,
  type DatasetRow,
  getDatasetRowValidationError,
  type LinkProjectionDefinition,
  ObjectNotFoundError,
  objectService,
} from "@sixb/core"
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

interface RunLinkProjectionInput {
  readonly runtime: ProjectionWorkerContext
  readonly projection: LinkProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly versionId: string
  readonly signal: AbortSignal
  readonly batchSize: number
  readonly onProgress?: ProjectionProgressReporter
}

interface CollectedLinkRow {
  readonly sourceId: string
  readonly targetId: string
}

interface LinkItem {
  readonly objectTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly target: {
    readonly targetTypeId: string
    readonly targetId: string
  }
}

export async function runLinkProjection(
  input: RunLinkProjectionInput
): Promise<ProjectionExecutionResult> {
  const { runtime, projection, dataset, versionId, signal, batchSize, onProgress } = input
  const counters = createZeroCounters()
  const seenPairs = new Set<string>()
  const batch: CollectedLinkRow[] = []
  let firstErrorMessage: string | undefined

  const rememberError = (message: string): void => {
    firstErrorMessage ??= message
  }

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) {
      return
    }

    const rows = batch.splice(0, batch.length)
    const linkItems: LinkItem[] = rows.map((row) => ({
      objectTypeId: projection.sourceObjectTypeId,
      sourceId: row.sourceId,
      linkId: projection.linkId,
      target: {
        targetTypeId: projection.targetObjectTypeId,
        targetId: row.targetId,
      },
    }))

    const linkResults = await objectService.upsertLinkBatch(runtime, linkItems)
    for (let index = 0; index < linkResults.length; index += 1) {
      const result = linkResults[index]
      if (result?.ok) {
        counters.linksUpserted += 1
        continue
      }

      counters.rowsSkipped += 1
      if (!(result?.error instanceof ObjectNotFoundError)) {
        rememberError(errorMessage(result?.error))
      }
    }

    await onProgress?.(snapshotCounters(counters))
  }

  for await (const row of runtime.lakeStorage.readRows({
    datasetId: projection.datasetId,
    versionId,
    columns: linkProjectionReadColumns(projection),
  })) {
    throwIfAborted(signal)
    counters.rowsProcessed += 1

    const validationError = getDatasetRowValidationError(row, dataset, {
      columns: linkProjectionReadColumns(projection),
    })
    if (validationError) {
      counters.rowsSkipped += 1
      rememberError(validationError)
      continue
    }

    const linkRow = collectLinkRow(projection, row)
    if (!linkRow) {
      counters.rowsSkipped += 1
      continue
    }

    const pairKey = `${linkRow.sourceId}\0${linkRow.targetId}`
    if (seenPairs.has(pairKey)) {
      counters.rowsSkipped += 1
      continue
    }
    seenPairs.add(pairKey)

    batch.push(linkRow)
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

function linkProjectionReadColumns(projection: LinkProjectionDefinition): readonly string[] {
  return [...new Set([projection.sourceField, projection.targetField])]
}

function collectLinkRow(
  projection: LinkProjectionDefinition,
  row: DatasetRow
): CollectedLinkRow | null {
  const sourceId = row[projection.sourceField]
  const targetId = row[projection.targetField]

  if (isBlank(sourceId) || isBlank(targetId)) {
    return null
  }

  return {
    sourceId: String(sourceId),
    targetId: String(targetId),
  }
}
