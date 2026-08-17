import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import { type AdmitWebhookRunInput, admitWebhookRun } from "../src/webhooks/run-admission"

describe("Webhook run admission", () => {
  test("persists the execution and run atomically before returning authority", async () => {
    const storage = new InMemoryStorage()
    const result = await admitWebhookRun(admissionInput(storage, "run-1", "delivery-1"))

    expect(result).toMatchObject({ status: "admitted", retried: false })
    if (result.status !== "admitted") throw new Error("Expected an admitted Webhook run.")
    expect(result.run.executionId).toBe(result.execution.id)
    await expect(
      storage.executions.getById({ projectId: "webhook-admission", id: result.execution.id })
    ).resolves.toEqual(result.execution)
    await expect(
      storage.webhookRuns.getById({ projectId: "webhook-admission", id: "run-1" })
    ).resolves.toEqual(result.run)
  })

  test("rolls back both records when the admission transaction fails", async () => {
    const storage = new InMemoryStorage()
    let executionId: string | undefined
    const restore = decorateOperationScopedMethodForTesting(
      storage.webhookRuns,
      "start",
      (start) => async (input) => {
        executionId = input.executionId
        await start(input)
        throw new Error("injected admission failure")
      }
    )

    try {
      await expect(admitWebhookRun(admissionInput(storage, "run-rollback"))).rejects.toThrow(
        "injected admission failure"
      )
    } finally {
      restore()
    }
    expect(executionId).toBeString()
    await expect(
      storage.webhookRuns.getById({ projectId: "webhook-admission", id: "run-rollback" })
    ).resolves.toBeNull()
    await expect(
      executionId
        ? storage.executions.getById({ projectId: "webhook-admission", id: executionId })
        : null
    ).resolves.toBeNull()
  })

  test("retries one delivery with its original run and execution", async () => {
    const storage = new InMemoryStorage()
    const first = await admitWebhookRun(admissionInput(storage, "run-first", "delivery-retry"))
    if (first.status !== "admitted") throw new Error("Expected the first admission to succeed.")
    await storage.webhookRuns.finish({
      projectId: "webhook-admission",
      id: first.run.id,
      status: "failed",
      finishedAt: new Date("2026-06-01T12:00:00.000Z"),
      responseStatus: 503,
      error: {
        code: "webhook.delivery_failed",
        message: "Webhook delivery failed.",
        retryable: true,
        at: "2026-06-01T12:00:00.000Z",
      },
    })

    const retry = await admitWebhookRun(
      admissionInput(storage, "run-new-candidate", "delivery-retry")
    )
    expect(retry).toMatchObject({
      status: "admitted",
      retried: true,
      run: { id: first.run.id, executionId: first.execution.id, status: "running" },
      execution: { id: first.execution.id },
    })
    expect(await storage.webhookRuns.list({ projectId: "webhook-admission" })).toMatchObject({
      total: 1,
    })
  })
})

function admissionInput(
  storage: InMemoryStorage,
  runId: string,
  idempotencyKey?: string
): AdmitWebhookRunInput {
  return {
    storage,
    projectId: "webhook-admission",
    runId,
    connectorId: "github",
    webhookId: "events",
    method: "POST",
    route: "/api/webhooks/github/events",
    requestBodyBytes: 12,
    requestBodySha256: "0".repeat(64),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  }
}
