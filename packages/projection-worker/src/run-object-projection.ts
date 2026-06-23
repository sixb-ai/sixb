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
import { type FlushContext, runStreamingProjection } from "./run-streaming-projection"
import type {
  ProjectionExecutionResult,
  ProjectionProgressReporter,
  ProjectionWorkerContext,
} from "./types"
import { errorMessage, isBlank } from "./utils"

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
  const primaryPropertyId = runtime.ontology.getPrimaryPropertyId(projection.objectTypeId)
  const projectionPlan = buildObjectProjectionPlan({
    ontology: runtime.ontology,
    projection,
    dataset,
    primaryPropertyId,
  })

  return runStreamingProjection<ProjectedObjectRow>({
    runtime,
    signal,
    batchSize,
    onProgress,
    spec: {
      datasetId: projection.datasetId,
      versionId,
      readColumns: objectProjectionReadColumns(projection),
      projectRow(row) {
        const projected = projectObjectRow(projectionPlan, row)
        if (!projected.ok) {
          return { status: "fail", errorMessage: projected.errorMessage }
        }
        if (isBlank(projected.row.primaryValue)) {
          return { status: "skip" }
        }
        return { status: "item", item: projected.row }
      },
      flushBatch: (rows, ctx) => flushObjectBatch({ runtime, projection, rows, ctx }),
    },
  })
}

async function flushObjectBatch(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: ObjectProjectionDefinition
  readonly rows: readonly ProjectedObjectRow[]
  readonly ctx: FlushContext
}): Promise<void> {
  const { runtime, projection, rows, ctx } = input
  const { counters, rememberError } = ctx

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
}

function objectProjectionReadColumns(projection: ObjectProjectionDefinition): readonly string[] {
  const linkSourceFields = Object.values(projection.links).flatMap((descriptor) =>
    descriptor.sourceField ? [descriptor.sourceField] : []
  )
  return [...new Set([...Object.values(projection.properties), ...linkSourceFields])]
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
      const fkValue = row.foreignKeyValues[descriptor.linkId]
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
