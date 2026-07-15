import {
  type DatasetDefinition,
  type DatasetRow,
  getDatasetRowValidationError,
  type LinkProjectionDefinition,
  ObjectNotFoundError,
} from "@sixb/core"
import { objectService } from "@sixb/core/internal/objects"
import { type FlushContext, runStreamingProjection } from "./run-streaming-projection"
import type {
  ProjectionExecutionResult,
  ProjectionProgressReporter,
  ProjectionWorkerContext,
} from "./types"
import { errorMessage, isBlank } from "./utils"

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
  const readColumns = linkProjectionReadColumns(projection)
  const seenPairs = new Set<string>()

  return runStreamingProjection<CollectedLinkRow>({
    runtime,
    signal,
    batchSize,
    onProgress,
    spec: {
      datasetId: projection.datasetId,
      versionId,
      readColumns,
      projectRow(row) {
        const validationError = getDatasetRowValidationError(row, dataset, { columns: readColumns })
        if (validationError) {
          return { status: "fail", errorMessage: validationError }
        }

        const linkRow = collectLinkRow(projection, row)
        if (!linkRow) {
          return { status: "skip" }
        }

        const pairKey = `${linkRow.sourceId}\0${linkRow.targetId}`
        if (seenPairs.has(pairKey)) {
          return { status: "skip" }
        }
        seenPairs.add(pairKey)

        return { status: "item", item: linkRow }
      },
      flushBatch: (rows, ctx) => flushLinkBatch({ runtime, projection, rows, ctx }),
    },
  })
}

async function flushLinkBatch(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: LinkProjectionDefinition
  readonly rows: readonly CollectedLinkRow[]
  readonly ctx: FlushContext
}): Promise<void> {
  const { runtime, projection, rows, ctx } = input
  const { counters, rememberError } = ctx

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
