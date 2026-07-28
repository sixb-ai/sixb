import {
  type DatasetDefinition,
  isJsonValue,
  MaterializationValidationError,
  type ObjectProjectionDefinition,
} from "@sixb/core"
import type { ProjectionSourceEntry } from "@sixb/core/internal/materialization"
import {
  buildObjectProjectionPlan,
  type ProjectedObjectRow,
  projectObjectRow,
} from "./object-projection-plan"
import { ReplacementProgress } from "./replacement-progress"
import type { ClaimedProjectionExecution, ProjectionWorkerContext } from "./types"
import { isBlank, throwIfAborted } from "./utils"

export function mapObjectProjectionEntries(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: ObjectProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly execution: ClaimedProjectionExecution
  readonly signal: AbortSignal
}): AsyncIterable<ProjectionSourceEntry> {
  const { runtime, projection, dataset, execution, signal } = input
  const plan = buildObjectProjectionPlan({
    ontology: runtime.ontology,
    projection,
    dataset,
    primaryPropertyId: runtime.ontology.getPrimaryPropertyId(projection.objectTypeId),
  })
  const progress = createProgress(runtime, execution)

  return entries()

  async function* entries(): AsyncIterable<ProjectionSourceEntry> {
    try {
      for await (const row of runtime.lakeStorage.readRows({
        datasetId: execution.run.datasetId,
        versionId: execution.run.datasetVersionId,
        columns: objectProjectionReadColumns(projection),
      })) {
        throwIfAborted(signal)
        const projected = projectObjectRow(plan, row)
        if (!projected.ok) {
          await failCurrentRow(progress, projected.errorMessage)
          continue
        }
        if (isBlank(projected.row.primaryValue)) {
          await progress.recordRow(true)
          continue
        }

        let entry: ProjectionSourceEntry
        try {
          entry = toSourceEntry(projection, plan.primaryPropertyId, projected.row)
        } catch (error) {
          if (error instanceof MaterializationValidationError) {
            await failCurrentRow(progress, error.message)
          }
          throw error
        }
        await progress.recordRow(false)
        yield entry
      }
    } finally {
      await progress.flush()
    }
  }
}

function toSourceEntry(
  projection: ObjectProjectionDefinition,
  primaryPropertyId: string,
  row: ProjectedObjectRow
): ProjectionSourceEntry {
  const primaryId = requireIdentity(row.primaryValue, projection.id, "primary property")
  const objectRef = { objectTypeId: projection.objectTypeId, primaryId }
  const properties = Object.fromEntries(
    Object.entries(row.properties).filter(([propertyId]) => propertyId !== primaryPropertyId)
  )
  if (!isJsonValue(properties)) {
    throw validationError(projection.id, "produced non-JSON object properties")
  }

  const linkAssertions: ProjectionSourceEntry["assertions"] = Object.values(
    projection.links
  ).flatMap((descriptor) => {
    const value = row.foreignKeyValues[descriptor.linkId]
    if (isBlank(value)) return []
    const targetId = requireIdentity(value, projection.id, `foreign key '${descriptor.linkId}'`)
    return [
      {
        kind: "link" as const,
        ref: {
          source: objectRef,
          linkId: descriptor.linkId,
          target: { objectTypeId: descriptor.targetObjectTypeId, primaryId: targetId },
        },
      },
    ]
  })

  return {
    root: { kind: "object", ref: objectRef },
    assertions: [{ kind: "object", ref: objectRef, properties }, ...linkAssertions],
  }
}

function objectProjectionReadColumns(projection: ObjectProjectionDefinition): readonly string[] {
  const linkSourceFields = Object.values(projection.links).flatMap((descriptor) =>
    descriptor.sourceField ? [descriptor.sourceField] : []
  )
  return [...new Set([...Object.values(projection.properties), ...linkSourceFields])]
}

function requireIdentity(value: unknown, projectionId: string, field: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value
  throw validationError(projectionId, `${field} must produce a non-empty string identity`)
}

function createProgress(
  runtime: ProjectionWorkerContext,
  execution: ClaimedProjectionExecution
): ReplacementProgress {
  return new ReplacementProgress({
    storage: runtime.projectionRunsStorage,
    projectId: runtime.projectId,
    projectionRunId: execution.run.id,
    executionToken: execution.run.executionToken,
    identity: execution.identity,
    persistedRowsRead: execution.run.sourceRowsRead,
    persistedRowsSkipped: execution.run.sourceRowsSkipped,
  })
}

async function failCurrentRow(progress: ReplacementProgress, message: string): Promise<never> {
  await progress.recordRow(false)
  await progress.flush()
  throw new MaterializationValidationError(message)
}

function validationError(projectionId: string, message: string): MaterializationValidationError {
  return new MaterializationValidationError(`Projection '${projectionId}' ${message}.`)
}
