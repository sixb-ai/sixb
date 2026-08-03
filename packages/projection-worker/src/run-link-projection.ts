import {
  type DatasetDefinition,
  getDatasetRowValidationError,
  type LinkProjectionDefinition,
} from "@sixb/core"
import { SixbError } from "@sixb/core/errors"
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
        datasetId: execution.run.identity.datasetVersion.datasetId,
        versionId: execution.run.identity.datasetVersion.versionId,
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
      progress.assertComplete()
    } finally {
      await progress.flush()
    }
  }
}

function requireIdentity(value: unknown, projectionId: string, column: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value
  throw new SixbError(
    "ontology.invalid_value",
    `[Sixb] Projection '${projectionId}' dataset column '${column}' must produce a non-empty string identity.`
  )
}

/** Records the row as failed, flushes the run's progress, then reports what went wrong. */
async function failCurrentRow(
  progress: ReplacementProgress,
  failure: string | SixbError
): Promise<never> {
  await progress.recordRow(false)
  await progress.flush()
  throw typeof failure === "string"
    ? new SixbError("ontology.invalid_value", `[Sixb] ${failure}`)
    : failure
}
