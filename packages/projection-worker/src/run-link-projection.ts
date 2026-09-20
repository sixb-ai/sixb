import {
  type DatasetDefinition,
  type DatasetRow,
  getDatasetRowValidationError,
  type LinkProjectionDefinition,
  MaterializationValidationError,
} from "@sixb/core"
import type { ProjectionSourceEntry } from "@sixb/core/internal/materialization"
import { ReplacementProgress } from "./replacement-progress"
import type { ClaimedProjectionExecution, ProjectionWorkerContext } from "./types"
import { isBlank, throwIfAborted } from "./utils"

export function mapLinkProjectionEntries(input: {
  readonly runtime: ProjectionWorkerContext
  readonly projection: LinkProjectionDefinition
  readonly dataset: DatasetDefinition
  readonly execution: ClaimedProjectionExecution
  readonly expectedRows?: number
  readonly signal: AbortSignal
}): AsyncIterable<ProjectionSourceEntry> {
  const { runtime, projection, dataset, execution, expectedRows, signal } = input
  const columns = [...new Set([projection.sourceField, projection.targetField])]
  const progress = new ReplacementProgress({
    storage: runtime.projectionRunsStorage,
    projectId: runtime.projectId,
    projectionRunId: execution.run.id,
    executionToken: execution.execution.executionToken,
    identity: execution.run.identity,
    persistedRowsRead: execution.run.progress.sourceRowsRead,
    persistedRowsSkipped: execution.run.progress.sourceRowsSkipped,
    ...(expectedRows === undefined ? {} : { expectedRows }),
  })

  return entries()

  async function* entries(): AsyncIterable<ProjectionSourceEntry> {
    try {
      for await (const row of runtime.lakeStorage.readRows({
        signal,
        datasetId: execution.run.identity.datasetVersion.datasetId,
        versionId: execution.run.identity.datasetVersion.versionId,
        columns,
      })) {
        throwIfAborted(signal)
        let entry: ProjectionSourceEntry | null
        try {
          entry = mapLinkProjectionRow(projection, dataset, row)
        } catch (error) {
          if (error instanceof MaterializationValidationError)
            await failCurrentRow(progress, error.message)
          throw error
        }
        await progress.recordRow(entry === null)
        if (entry) yield entry
      }
      progress.assertComplete()
    } finally {
      await progress.flush()
    }
  }
}

export function mapLinkProjectionRow(
  projection: LinkProjectionDefinition,
  dataset: DatasetDefinition,
  row: DatasetRow
): ProjectionSourceEntry | null {
  const columns = [...new Set([projection.sourceField, projection.targetField])]
  const validationError = getDatasetRowValidationError(row, dataset, { columns })
  if (validationError) throw new MaterializationValidationError(validationError)
  const sourceValue = row[projection.sourceField]
  const targetValue = row[projection.targetField]
  if (isBlank(sourceValue) || isBlank(targetValue)) return null
  const ref = {
    source: {
      objectTypeId: projection.sourceObjectTypeId,
      primaryId: requireIdentity(sourceValue, projection.id, projection.sourceField),
    },
    linkId: projection.linkId,
    target: {
      objectTypeId: projection.targetObjectTypeId,
      primaryId: requireIdentity(targetValue, projection.id, projection.targetField),
    },
  }
  return { root: { kind: "link", ref }, assertions: [{ kind: "link", ref }] }
}

function requireIdentity(value: unknown, projectionId: string, column: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value
  throw new MaterializationValidationError(
    `Projection '${projectionId}' dataset column '${column}' must produce a non-empty string identity.`
  )
}

async function failCurrentRow(progress: ReplacementProgress, message: string): Promise<never> {
  await progress.recordRow(false)
  await progress.flush()
  throw new MaterializationValidationError(message)
}
