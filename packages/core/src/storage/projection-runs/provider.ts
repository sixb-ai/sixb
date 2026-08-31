import type { ExecutionStorage } from "../executions"
import { findPrimitiveRunExecution } from "../executions/run-link"
import { ProjectionRunError } from "./errors"

export * from "./lifecycle"

/** Validate the semantic link between a durable Projection run and its immutable execution. */
export async function assertProjectionRunDurableExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
  readonly projectionId: string
  readonly datasetId: string
  readonly datasetVersionId: string
}): Promise<void> {
  const execution = await findPrimitiveRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    primitive: { kind: "projection", id: input.projectionId, runId: input.runId },
    sourceTypes: ["datasetVersion"],
  })
  if (
    !execution ||
    execution.source.type !== "datasetVersion" ||
    execution.source.datasetId !== input.datasetId ||
    execution.source.versionId !== input.datasetVersionId
  ) {
    throw new ProjectionRunError(
      `[Sixb] Execution '${input.executionId}' does not authorize Projection run '${input.runId}'.`
    )
  }
}
