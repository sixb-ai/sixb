import type { ExecutionStorage } from "../executions"
import { findPrimitiveRunExecution } from "../executions/run-link"
import { WebhookRunError } from "./errors"

/** Validate the semantic link between a durable Webhook delivery and its immutable execution. */
export async function assertWebhookRunExecution(input: {
  readonly executions: ExecutionStorage
  readonly projectId: string
  readonly executionId: string
  readonly runId: string
  readonly route: string
}): Promise<void> {
  const execution = await findPrimitiveRunExecution({
    executions: input.executions,
    projectId: input.projectId,
    executionId: input.executionId,
    primitive: { kind: "webhook", id: input.route, runId: input.runId },
    sourceTypes: ["webhook"],
  })
  if (
    !execution ||
    execution.source.type !== "webhook" ||
    execution.source.deliveryId !== input.runId
  ) {
    throw new WebhookRunError(
      `[Sixb] Execution '${input.executionId}' does not authorize Webhook run '${input.runId}'.`,
      "invalid_execution"
    )
  }
}
