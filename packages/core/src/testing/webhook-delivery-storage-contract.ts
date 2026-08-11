import { describe, expect, test } from "bun:test"
import type {
  WebhookDeliveryFailure,
  WebhookDeliveryKey,
  WebhookDeliveryStorage,
} from "../storage/webhook-deliveries"

export interface WebhookDeliveryStorageContractSuiteOptions<
  TStorage extends WebhookDeliveryStorage = WebhookDeliveryStorage,
> {
  /** Factory that returns an isolated webhook-delivery store for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly setup?: (storage: TStorage) => void | Promise<void>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const deliveryKey = {
  projectId: "contract-project",
  connectorId: "github",
  webhookId: "events",
  idempotencyKey: "delivery-1",
} as const satisfies WebhookDeliveryKey

const failure = {
  code: "webhook.delivery_failed",
  message: "Webhook delivery failed.",
  retryable: true,
  at: "2026-06-01T12:00:01.000Z",
  details: {
    connectorId: "github",
    webhookId: "events",
    idempotencyKey: "delivery-1",
    runId: "webhookrun-1",
  },
} as const satisfies WebhookDeliveryFailure

/** Runs the retryable inbound webhook-delivery contract against a provider. */
export function runWebhookDeliveryStorageContractSuite<TStorage extends WebhookDeliveryStorage>(
  label: string,
  options: WebhookDeliveryStorageContractSuiteOptions<TStorage>
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
    test("claims new deliveries and skips in-progress or completed duplicates", async () => {
      await withStorage(async (storage) => {
        await expect(storage.claim(claimInput("2026-06-01T12:00:00.000Z"))).resolves.toMatchObject({
          ...deliveryKey,
          status: "in_progress",
          claimResult: "claimed",
          receivedAt: "2026-06-01T12:00:00.000Z",
        })

        await expect(storage.claim(claimInput("2026-06-01T12:00:00.500Z"))).resolves.toMatchObject({
          ...deliveryKey,
          status: "in_progress",
          claimResult: "in_progress",
          receivedAt: "2026-06-01T12:00:00.000Z",
        })

        await storage.complete({
          ...deliveryKey,
          completedAt: "2026-06-01T12:00:00.750Z",
        })

        await expect(storage.claim(claimInput("2026-06-01T12:00:01.000Z"))).resolves.toMatchObject({
          ...deliveryKey,
          status: "completed",
          claimResult: "duplicate",
          receivedAt: "2026-06-01T12:00:00.000Z",
          completedAt: "2026-06-01T12:00:00.750Z",
        })
      })
    })

    test("persists a validated, detached failure and clears it on retry", async () => {
      await withStorage(async (storage) => {
        await storage.claim(claimInput("2026-06-01T12:00:00.000Z"))
        const mutableFailure = {
          code: "webhook.delivery_failed" as const,
          message: String(failure.message),
          retryable: true as const,
          at: failure.at,
          details: {
            connectorId: String(failure.details.connectorId),
            webhookId: String(failure.details.webhookId),
            idempotencyKey: String(failure.details.idempotencyKey),
            runId: String(failure.details.runId),
          },
        }

        const failed = await storage.fail({
          ...deliveryKey,
          failedAt: failure.at,
          failure: mutableFailure,
        })
        mutableFailure.message = "mutated after write"
        mutableFailure.details.runId = "mutated-after-write"

        expect(failed).toMatchObject({
          ...deliveryKey,
          status: "failed",
          failedAt: failure.at,
          failure,
        })
        expect(failed.failure).toEqual(failure)

        const retried = await storage.claim(claimInput("2026-06-01T12:00:02.000Z"))
        expect(retried).toMatchObject({
          ...deliveryKey,
          status: "in_progress",
          claimResult: "claimed",
          receivedAt: "2026-06-01T12:00:02.000Z",
        })
        expect(retried.failedAt).toBeUndefined()
        expect(retried.failure).toBeUndefined()
      })
    })

    test("rejects failures outside the delivery code contract without changing state", async () => {
      await withStorage(async (storage) => {
        await storage.claim(claimInput("2026-06-01T12:00:00.000Z"))

        await expect(
          storage.fail({
            ...deliveryKey,
            failedAt: failure.at,
            failure: { ...failure, code: "internal.unexpected", retryable: false } as never,
          })
        ).rejects.toThrow("code is not allowed by this failure contract")

        await expect(storage.claim(claimInput("2026-06-01T12:00:02.000Z"))).resolves.toMatchObject({
          status: "in_progress",
          claimResult: "in_progress",
          receivedAt: "2026-06-01T12:00:00.000Z",
        })
      })
    })

    test("scopes delivery keys by connector and webhook", async () => {
      await withStorage(async (storage) => {
        await storage.claim(claimInput("2026-06-01T12:00:00.000Z"))

        await expect(
          storage.claim({
            ...deliveryKey,
            connectorId: "stripe",
            receivedAt: "2026-06-01T12:00:01.000Z",
          })
        ).resolves.toMatchObject({ status: "in_progress", claimResult: "claimed" })
        await expect(
          storage.claim({
            ...deliveryKey,
            webhookId: "workflow-job",
            receivedAt: "2026-06-01T12:00:02.000Z",
          })
        ).resolves.toMatchObject({ status: "in_progress", claimResult: "claimed" })
      })
    })
  })
}

function claimInput(receivedAt: string) {
  return { ...deliveryKey, receivedAt }
}
