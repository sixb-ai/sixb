import { describe, expect, test } from "bun:test"
import type { SixbFailure } from "../errors/types"
import type { CreateExecutionInput, Storage } from "../storage"
import type { WebhookRunFailureCode } from "../storage/webhook-runs"
import { startTestWebhookRun } from "./webhook-execution"

export type WebhookRunStorageContractStorage = Storage & {
  readonly webhookRuns: NonNullable<Storage["webhookRuns"]>
}

export interface WebhookRunStorageContractSuiteOptions<
  TStorage extends WebhookRunStorageContractStorage = WebhookRunStorageContractStorage,
> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "webhook-contract"
const route = "/api/webhooks/github/events"
const bodySha256 = "0".repeat(64)
const finishedAt = new Date("2026-06-01T12:01:00.000Z")
const retryableFailure = {
  code: "webhook.delivery_failed",
  message: "Webhook delivery failed.",
  retryable: true,
  at: finishedAt.toISOString(),
  details: { connectorId: "github", webhookId: "events", runId: "delivery-retry" },
} as const satisfies SixbFailure<WebhookRunFailureCode>
const rejectedFailure = {
  code: "webhook.delivery_rejected",
  message: "Webhook delivery was rejected.",
  retryable: false,
  at: finishedAt.toISOString(),
} as const satisfies SixbFailure<WebhookRunFailureCode>

/** Runs the durable Webhook delivery contract against one complete storage provider. */
export function runWebhookRunStorageContractSuite<
  TStorage extends WebhookRunStorageContractStorage,
>(label: string, options: WebhookRunStorageContractSuiteOptions<TStorage>): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("round-trips the immutable execution and delivery identity", async () => {
      await withStorage(async (storage) => {
        const run = await startTestWebhookRun(storage, runInput("delivery-1", "provider-1"))
        expect(run).toMatchObject({
          id: "delivery-1",
          projectId,
          executionId: "test_webhook_execution:delivery-1",
          connectorId: "github",
          webhookId: "events",
          status: "running",
          route,
          requestBodyBytes: 12,
          requestBodySha256: bodySha256,
          idempotencyKey: "provider-1",
        })
        await expect(
          storage.webhookRuns.getByDelivery({
            projectId,
            connectorId: "github",
            webhookId: "events",
            idempotencyKey: "provider-1",
          })
        ).resolves.toEqual(run)
      })
    })

    test("rejects missing or mismatched execution authority", async () => {
      await withStorage(async (storage) => {
        const missing = runInput("missing-execution")
        await expect(
          storage.webhookRuns.start({ ...missing, executionId: "missing" })
        ).rejects.toMatchObject({ code: "invalid_execution" })

        await storage.executions.create(disabledRequestExecution("wrong-execution"))
        await expect(
          storage.webhookRuns.start({ ...missing, executionId: "wrong-execution" })
        ).rejects.toMatchObject({ code: "invalid_execution" })
      })
    })

    test("enforces one run per provider delivery key", async () => {
      await withStorage(async (storage) => {
        await startTestWebhookRun(storage, runInput("delivery-first", "provider-shared"))
        await expect(
          startTestWebhookRun(storage, runInput("delivery-second", "provider-shared"))
        ).rejects.toMatchObject({ code: "duplicate_run" })
      })
    })

    test("restarts only retryable failures without changing execution identity", async () => {
      await withStorage(async (storage) => {
        const started = await startTestWebhookRun(
          storage,
          runInput("delivery-retry", "provider-retry")
        )
        await storage.webhookRuns.finish({
          projectId,
          id: started.id,
          status: "failed",
          finishedAt,
          responseStatus: 503,
          error: retryableFailure,
        })
        const restarted = await storage.webhookRuns.restart({ projectId, id: started.id })
        expect(restarted).toMatchObject({
          id: started.id,
          executionId: started.executionId,
          status: "running",
        })
        expect(restarted.finishedAt).toBeUndefined()
        expect(restarted.responseStatus).toBeUndefined()
        expect(restarted.error).toBeUndefined()

        await storage.webhookRuns.finish({
          projectId,
          id: started.id,
          status: "succeeded",
          responseStatus: 202,
        })
        await expect(
          storage.webhookRuns.restart({ projectId, id: started.id })
        ).rejects.toMatchObject({ code: "invalid_transition" })
      })
    })

    test("does not reopen a terminal client rejection", async () => {
      await withStorage(async (storage) => {
        const run = await startTestWebhookRun(storage, runInput("delivery-rejected"))
        await storage.webhookRuns.finish({
          projectId,
          id: run.id,
          status: "failed",
          finishedAt,
          responseStatus: 422,
          error: rejectedFailure,
        })
        await expect(storage.webhookRuns.restart({ projectId, id: run.id })).rejects.toMatchObject({
          code: "invalid_transition",
        })
      })
    })

    test("persists a validated, detached failure through get and list", async () => {
      await withStorage(async (storage) => {
        const run = await startTestWebhookRun(storage, runInput("failed-run", "failed-key"))
        const failedRunFailure = {
          ...retryableFailure,
          details: { ...retryableFailure.details, runId: run.id },
        }
        const mutableFailure = {
          code: "webhook.delivery_failed" as const,
          message: String(failedRunFailure.message),
          retryable: true as const,
          at: failedRunFailure.at,
          details: {
            connectorId: String(failedRunFailure.details.connectorId),
            webhookId: String(failedRunFailure.details.webhookId),
            runId: String(failedRunFailure.details.runId),
          },
        }
        const finished = await storage.webhookRuns.finish({
          projectId,
          id: run.id,
          status: "failed",
          finishedAt,
          responseStatus: 503,
          error: mutableFailure,
        })

        mutableFailure.details.runId = "mutated-after-write"
        expect(finished.error).toEqual(failedRunFailure)
        await expect(storage.webhookRuns.getById({ projectId, id: run.id })).resolves.toMatchObject(
          {
            error: failedRunFailure,
          }
        )
        await expect(
          storage.webhookRuns.list({
            projectId,
            statuses: ["failed"],
            idempotencyKey: "failed-key",
          })
        ).resolves.toMatchObject({ runs: [{ id: run.id, error: failedRunFailure }], total: 1 })
      })
    })

    test("rejects failures outside the Webhook run contract without finishing", async () => {
      await withStorage(async (storage) => {
        const run = await startTestWebhookRun(storage, runInput("invalid-failure"))
        await expect(
          storage.webhookRuns.finish({
            projectId,
            id: run.id,
            status: "failed",
            finishedAt,
            error: { ...retryableFailure, code: "runtime.cancelled" } as never,
          })
        ).rejects.toThrow("code is not allowed by this failure contract")
        const unchanged = await storage.webhookRuns.getById({ projectId, id: run.id })
        expect(unchanged?.status).toBe("running")
        expect(unchanged?.error).toBeUndefined()
      })
    })
  })
}

function runInput(id: string, idempotencyKey?: string) {
  return {
    id,
    projectId,
    connectorId: "github",
    webhookId: "events",
    method: "POST",
    route,
    requestBodyBytes: 12,
    requestBodySha256: bodySha256,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    startedAt: new Date("2026-06-01T12:00:00.000Z"),
  }
}

function disabledRequestExecution(id: string): CreateExecutionInput {
  return {
    id,
    projectId,
    executor: { type: "request", requestId: id },
    source: { type: "http", requestId: id },
    correlationId: `correlation:${id}`,
    authorizationRef: { type: "disabled" },
  }
}
