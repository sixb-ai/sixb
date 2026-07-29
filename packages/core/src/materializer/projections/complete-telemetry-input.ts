import { MaterializationValidationError } from "../../materialization/errors"
import type {
  ProjectionMaterializationIdentity,
  ProjectionTelemetryInputCompletion,
} from "../../materialization/model"
import type { ResolvedProjection, TelemetryProjectionDefinition } from "../../projections/types"
import type { MaterializerContext, MaterializerStorage } from "../context"
import { withSerializationRetry } from "../execution/commit-lifecycle"
import { assertProjectionMaterializationExecution } from "../execution/run-correlation"
import {
  normalizePinnedDatasetVersion,
  normalizeProjectionExecution,
  normalizeProjectionSourceRef,
} from "../shared/normalize"
import { createProjectionRunMaterializationIdentity } from "../shared/projection-run"

interface PreparedTelemetryInputCompletion {
  readonly projectId: string
  readonly input: ProjectionTelemetryInputCompletion
  readonly identity: ProjectionMaterializationIdentity
  readonly resolved: ResolvedProjection<TelemetryProjectionDefinition>
}

/** Persists the worker's EOF observation before terminal run success is allowed. */
export async function completeProjectionTelemetryInput(
  context: MaterializerContext,
  raw: ProjectionTelemetryInputCompletion
): Promise<void> {
  const command = prepareTelemetryInputCompletion(context, raw)
  await withSerializationRetry(context, () =>
    context.storage.transaction((storage) => completeTelemetryInputTransaction(storage, command), {
      isolation: "serializable",
    })
  )
}

function prepareTelemetryInputCompletion(
  context: Pick<MaterializerContext, "projectId" | "projectionRegistry">,
  raw: ProjectionTelemetryInputCompletion
): PreparedTelemetryInputCompletion {
  const source = normalizeProjectionSourceRef(raw.source)
  const datasetVersion = normalizePinnedDatasetVersion(raw.datasetVersion)
  const execution = normalizeProjectionExecution(raw.execution)
  const resolved = context.projectionRegistry.resolveTelemetry(source.projectionId)
  if (resolved.datasetId !== datasetVersion.datasetId) {
    throw new MaterializationValidationError(
      `Projection '${resolved.projectionId}' requires dataset '${resolved.datasetId}'.`
    )
  }
  return {
    projectId: context.projectId,
    input: { source, datasetVersion, execution },
    identity: createProjectionRunMaterializationIdentity({
      resolved,
      datasetVersion,
      ontologyRevision: context.projectionRegistry.ontologyRevision,
    }),
    resolved,
  }
}

async function completeTelemetryInputTransaction(
  storage: MaterializerStorage,
  command: PreparedTelemetryInputCompletion
): Promise<void> {
  const { projectionRuns } = await assertProjectionMaterializationExecution(storage, {
    projectId: command.projectId,
    projectionRunId: command.input.execution.projectionRunId,
    executionToken: command.input.execution.executionToken,
    identity: command.identity,
    resolved: command.resolved,
  })
  await projectionRuns.completeTelemetryInput({
    id: command.input.execution.projectionRunId,
    projectId: command.projectId,
    executionToken: command.input.execution.executionToken,
    identity: command.identity,
  })
}
