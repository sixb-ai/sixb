import type { ExecutionStorage } from "../executions"
import { findPrimitiveRunExecution } from "../executions/run-link"
import { ActionRunError } from "./errors"

/** Validate the semantic link between a durable Action run and its immutable execution. */
export async function assertActionRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
  readonly actionId: string
}): Promise<void> {
  const execution = await findPrimitiveRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    primitive: { kind: "action", id: input.actionId, runId: input.runId },
    sourceTypes: ["execution"],
  })
  if (!execution) {
    throw new ActionRunError(
      `[Sixb] Execution '${input.executionId}' does not authorize Action run '${input.runId}'.`
    )
  }
}
