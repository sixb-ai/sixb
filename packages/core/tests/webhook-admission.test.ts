import { afterEach, describe, expect, jest, setSystemTime, test } from "bun:test"
import { InMemoryStorage } from "../src"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import {
  canRetryWebhookRun,
  WEBHOOK_RUN_LEASE_MS,
  type WebhookRunRecord,
} from "../src/storage/webhook-runs"
import { holdWebhookRun } from "../src/webhooks/delivery-lease"
import { type AdmitWebhookRunInput, admitWebhookRun } from "../src/webhooks/run-admission"

describe("Webhook run admission", () => {
  afterEach(() => {
    setSystemTime()
    jest.useRealTimers()
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

  test("persists the run and its execution, and retries one delivery with both", async () => {
    const storage = new InMemoryStorage()
    const first = await admitWebhookRun(admissionInput(storage, "run-first", "delivery-retry"))
    expect(first).toMatchObject({ status: "admitted", retried: false })
    if (first.status !== "admitted") throw new Error("Expected the first admission to succeed.")
    expect(first.run.executionId).toBe(first.execution.id)
    await expect(
      storage.executions.getById({ projectId: "webhook-admission", id: first.execution.id })
    ).resolves.toEqual(first.execution)
    await expect(
      storage.webhookRuns.getById({ projectId: "webhook-admission", id: "run-first" })
    ).resolves.toEqual(first.run)

    await storage.webhookRuns.finish({
      projectId: "webhook-admission",
      id: first.run.id,
      executionToken: String(first.run.execution?.token),
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

  // Answer `in_progress` for every running run to watch a crashed delivery get 202 forever.
  test("takes over a delivery whose lease ran out, and shuts out the execution that lost it", async () => {
    const storage = new InMemoryStorage()
    const first = await admitWebhookRun(admissionInput(storage, "run-first", "delivery-lost"))
    if (first.status !== "admitted") throw new Error("Expected the first admission to succeed.")

    await expect(
      admitWebhookRun(admissionInput(storage, "run-second", "delivery-lost"))
    ).resolves.toMatchObject({ status: "in_progress", run: { id: first.run.id } })

    setSystemTime(new Date(Date.now() + WEBHOOK_RUN_LEASE_MS + 1))

    const retry = await admitWebhookRun(admissionInput(storage, "run-third", "delivery-lost"))
    expect(retry).toMatchObject({ status: "admitted", retried: true, run: { id: first.run.id } })

    await expect(
      storage.webhookRuns.finish({
        projectId: "webhook-admission",
        id: first.run.id,
        executionToken: String(first.run.execution?.token),
        status: "succeeded",
      })
    ).rejects.toMatchObject({ code: "invalid_transition" })
  })

  // Stop renewing to watch the retry run the handler beside the one still running.
  // Treat a run without a lease as lapsed to watch a retry run the handler beside the older API.
  test("judges a run an older API started from when it started", () => {
    const startedAt = new Date("2026-11-07T00:00:00.000Z")
    const run = { status: "running", startedAt } as WebhookRunRecord

    expect(canRetryWebhookRun(run, startedAt)).toBe(false)
    expect(canRetryWebhookRun(run, new Date(startedAt.getTime() + WEBHOOK_RUN_LEASE_MS))).toBe(true)
  })

  test("keeps a handler that outlives the lease held, so a retry does not run it twice", async () => {
    jest.useFakeTimers()
    const storage = new InMemoryStorage()
    const first = await admitWebhookRun(admissionInput(storage, "run-slow", "delivery-slow"))
    if (first.status !== "admitted") throw new Error("Expected the first admission to succeed.")

    const execution = first.run.execution
    if (!execution) throw new Error("Expected the admitted run to be held.")
    const stopHolding = holdWebhookRun({
      storage,
      projectId: "webhook-admission",
      runId: first.run.id,
      execution,
    })

    for (let elapsed = 0; elapsed < 5 * WEBHOOK_RUN_LEASE_MS; elapsed += 15_000) {
      jest.advanceTimersByTime(15_000)
      await Promise.resolve()
    }

    await expect(
      admitWebhookRun(admissionInput(storage, "run-retry", "delivery-slow"))
    ).resolves.toMatchObject({ status: "in_progress" })

    stopHolding()
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
