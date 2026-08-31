import type { TrustedPrimitiveRef } from "../execution"
import type { StartWebhookRunInput, Storage, WebhookRunRecord } from "../storage"
import type { ExecutionStorage } from "../storage/executions"

/** Create the durable execution required by a Webhook-run storage fixture. */
export async function createTestWebhookExecution(
  executions: ExecutionStorage,
  input: {
    readonly projectId: string
    readonly route: string
    readonly runId: string
    readonly executionId?: string
  }
): Promise<string> {
  const executionId = input.executionId ?? `test_webhook_execution:${input.runId}`
  const existing = await executions.getById({ projectId: input.projectId, id: executionId })
  if (existing) return executionId

  const primitive: TrustedPrimitiveRef = {
    kind: "webhook",
    id: input.route,
    runId: input.runId,
  }
  await executions.create({
    id: executionId,
    projectId: input.projectId,
    executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
    source: { type: "webhook", deliveryId: input.runId },
    correlationId: `test_correlation:${input.runId}`,
    authorizationRef: { type: "trustedPrimitive", primitive },
  })
  return executionId
}

/** Start a Webhook run with the valid durable execution fixture required by every provider. */
export async function startTestWebhookRun(
  storage: Pick<Storage, "webhookRuns" | "executions">,
  input: Omit<StartWebhookRunInput, "executionId">
): Promise<WebhookRunRecord> {
  if (!storage.webhookRuns) throw new Error("Webhook run storage is not configured for this test.")
  const executionId = await createTestWebhookExecution(storage.executions, {
    projectId: input.projectId,
    route: input.route,
    runId: input.id,
  })
  return storage.webhookRuns.start({ ...input, executionId })
}
