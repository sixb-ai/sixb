import {
  type DatasetDefinition,
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
  readonly signal: AbortSignal
}): AsyncIterable<ProjectionSourceEntry> {
  const { runtime, projection, dataset, execution, signal } = input
  const columns = [...new Set([projection.sourceField, projection.targetField])]
  const progress = new ReplacementProgress({
    storage: runtime.projectionRunsStorage,
    projectId: runtime.projectId,
    projectionRunId: execution.run.id,
    executionToken: execution.run.executionToken,
    identity: execution.identity,
    persistedRowsRead: execution.run.sourceRowsRead,
    persistedRowsSkipped: execution.run.sourceRowsSkipped,
  })

  return entries()

  async function* entries(): AsyncIterable<ProjectionSourceEntry> {
    try {
      for await (const row of runtime.lakeStorage.readRows({
        datasetId: execution.run.datasetId,
        versionId: execution.run.datasetVersionId,
        columns,
      })) {
        throwIfAborted(signal)
        const validationError = getDatasetRowValidationError(row, dataset, { columns })
        if (validationError) await failCurrentRow(progress, validationError)

        const sourceValue = row[projection.sourceField]
        const targetValue = row[projection.targetField]
        if (isBlank(sourceValue) || isBlank(targetValue)) {
          await progress.recordRow(true)
          continue
        }

        const sourceId = requireIdentity(sourceValue, projection.id, projection.sourceField)
        const targetId = requireIdentity(targetValue, projection.id, projection.targetField)
        const ref = {
          source: { objectTypeId: projection.sourceObjectTypeId, primaryId: sourceId },
          linkId: projection.linkId,
          target: { objectTypeId: projection.targetObjectTypeId, primaryId: targetId },
        }
        await progress.recordRow(false)
        yield {
          root: { kind: "link", ref },
          assertions: [{ kind: "link", ref }],
        }
      }
    } finally {
      await progress.flush()
    }
  }
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
