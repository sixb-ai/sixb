import { describe, expect, test } from "bun:test"
import type { SixbFailure } from "../errors/types"
import type { WebhookRunFailureCode, WebhookRunStorage } from "../storage/webhook-runs"

export interface WebhookRunStorageContractSuiteOptions<
  TStorage extends WebhookRunStorage = WebhookRunStorage,
> {
  /** Factory that returns an isolated webhook-run store for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly setup?: (storage: TStorage) => void | Promise<void>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "contract-project"
const startedAt = new Date("2026-06-01T11:59:00.000Z")
const finishedAt = new Date("2026-06-01T12:00:00.000Z")

const failure = {
  code: "webhook.delivery_failed",
  message: "Webhook delivery failed.",
  retryable: true,
  at: finishedAt.toISOString(),
  details: { connectorId: "github", webhookId: "events", runId: "failed-run" },
} as const satisfies SixbFailure<WebhookRunFailureCode>

/** Runs the durable webhook-run lifecycle and failure contract against a provider. */
export function runWebhookRunStorageContractSuite<TStorage extends WebhookRunStorage>(
  label: string,
  options: WebhookRunStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await options.setup?.(storage)
      await body(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("persists a validated, detached failure and exposes it through get and list", async () => {
      await withStorage(async (storage) => {
        await storage.start(runInput("failed-run"))
        const mutableFailure = {
          code: "webhook.delivery_failed" as const,
          message: String(failure.message),
          retryable: true as const,
          at: failure.at,
          details: {
            connectorId: String(failure.details.connectorId),
            webhookId: String(failure.details.webhookId),
            runId: String(failure.details.runId),
          },
        }
        const finished = await storage.finish({
          id: "failed-run",
          projectId,
          status: "failed",
          finishedAt,
          requestBodyBytes: 128,
          responseStatus: 500,
          idempotencyKey: "delivery-1",
          deliveryClaimResult: "claimed",
          error: mutableFailure,
        })

        mutableFailure.message = "mutated after write"
        mutableFailure.details.runId = "mutated-after-write"

        expect(finished).toMatchObject({
          id: "failed-run",
          status: "failed",
          finishedAt,
          requestBodyBytes: 128,
          responseStatus: 500,
          idempotencyKey: "delivery-1",
          deliveryClaimResult: "claimed",
          error: failure,
        })
        expect(await storage.getById({ projectId, id: "failed-run" })).toMatchObject({
          error: failure,
        })
        await expect(
          storage.list({ projectId, statuses: ["failed"], idempotencyKey: "delivery-1" })
        ).resolves.toMatchObject({ runs: [{ id: "failed-run", error: failure }], total: 1 })
      })
    })

    test("rejects failures outside the webhook-run code contract without finishing the run", async () => {
      await withStorage(async (storage) => {
        await storage.start(runInput("invalid-failure-run"))

        await expect(
          storage.finish({
            id: "invalid-failure-run",
            projectId,
            status: "failed",
            error: { ...failure, code: "runtime.cancelled" } as never,
          })
        ).rejects.toThrow("code is not allowed by this failure contract")
        const unchanged = await storage.getById({ projectId, id: "invalid-failure-run" })
        expect(unchanged?.status).toBe("running")
        expect(unchanged?.error).toBeUndefined()
      })
    })

    test("keeps successful and skipped runs failure-free and terminal", async () => {
      await withStorage(async (storage) => {
        await storage.start(runInput("succeeded-run"))
        await storage.start(runInput("skipped-run", "stripe", "payments"))

        await expect(
          storage.finish({
            id: "succeeded-run",
            projectId,
            status: "succeeded",
            finishedAt,
            responseStatus: 204,
          })
        ).resolves.toMatchObject({ status: "succeeded" })
        await expect(
          storage.finish({ id: "skipped-run", projectId, status: "skipped", finishedAt })
        ).resolves.toMatchObject({ status: "skipped" })
        expect((await storage.getById({ projectId, id: "succeeded-run" }))?.error).toBeUndefined()
        expect((await storage.getById({ projectId, id: "skipped-run" }))?.error).toBeUndefined()
        await expect(
          storage.finish({
            id: "succeeded-run",
            projectId,
            status: "failed",
            error: failure,
          })
        ).rejects.toThrow("already terminal")
      })
    })
  })
}

function runInput(id: string, connectorId = "github", webhookId = "events") {
  return {
    id,
    projectId,
    connectorId,
    webhookId,
    method: "POST",
    route: `/webhooks/${connectorId}/${webhookId}`,
    startedAt,
  }
}
