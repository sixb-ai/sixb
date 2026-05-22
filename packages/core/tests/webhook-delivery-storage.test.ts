import { describe, expect, test } from "bun:test"
import { InMemoryWebhookDeliveryStorage } from "../src/storage"

const deliveryKey = {
  projectId: "project-1",
  connectorId: "github",
  webhookId: "events",
  idempotencyKey: "delivery-1",
}

describe("InMemoryWebhookDeliveryStorage", () => {
  test("claims new deliveries and skips in-progress or completed duplicates", async () => {
    const storage = new InMemoryWebhookDeliveryStorage()

    await expect(
      storage.claim({
        ...deliveryKey,
        receivedAt: "2026-04-19T12:00:00.000Z",
      })
    ).resolves.toMatchObject({
      ...deliveryKey,
      status: "in_progress",
      claimResult: "claimed",
      receivedAt: "2026-04-19T12:00:00.000Z",
    })

    await expect(
      storage.claim({
        ...deliveryKey,
        receivedAt: "2026-04-19T12:00:01.000Z",
      })
    ).resolves.toMatchObject({
      ...deliveryKey,
      status: "in_progress",
      claimResult: "in_progress",
      receivedAt: "2026-04-19T12:00:00.000Z",
    })

    await storage.complete({
      ...deliveryKey,
      completedAt: "2026-04-19T12:00:02.000Z",
    })

    await expect(
      storage.claim({
        ...deliveryKey,
        receivedAt: "2026-04-19T12:00:03.000Z",
      })
    ).resolves.toMatchObject({
      ...deliveryKey,
      status: "completed",
      claimResult: "duplicate",
      receivedAt: "2026-04-19T12:00:00.000Z",
      completedAt: "2026-04-19T12:00:02.000Z",
    })
  })

  test("reclaims failed deliveries and scopes keys by connector and webhook", async () => {
    const storage = new InMemoryWebhookDeliveryStorage()

    await storage.claim({
      ...deliveryKey,
      receivedAt: "2026-04-19T12:00:00.000Z",
    })
    await storage.fail({
      ...deliveryKey,
      failedAt: "2026-04-19T12:00:01.000Z",
      error: "handler failed",
    })

    await expect(
      storage.claim({
        ...deliveryKey,
        receivedAt: "2026-04-19T12:00:02.000Z",
      })
    ).resolves.toMatchObject({
      ...deliveryKey,
      status: "in_progress",
      claimResult: "claimed",
      receivedAt: "2026-04-19T12:00:02.000Z",
    })

    await expect(
      storage.claim({
        ...deliveryKey,
        webhookId: "workflow-job",
        receivedAt: "2026-04-19T12:00:03.000Z",
      })
    ).resolves.toMatchObject({
      ...deliveryKey,
      webhookId: "workflow-job",
      status: "in_progress",
      claimResult: "claimed",
      receivedAt: "2026-04-19T12:00:03.000Z",
    })
  })

  test("returns updated records when completing and failing deliveries", async () => {
    const storage = new InMemoryWebhookDeliveryStorage()
    const failedDeliveryKey = {
      ...deliveryKey,
      webhookId: "workflow-job",
    }

    await storage.claim({
      ...deliveryKey,
      receivedAt: "2026-04-19T12:00:00.000Z",
    })

    await expect(
      storage.complete({
        ...deliveryKey,
        completedAt: "2026-04-19T12:00:01.000Z",
      })
    ).resolves.toMatchObject({
      ...deliveryKey,
      status: "completed",
      receivedAt: "2026-04-19T12:00:00.000Z",
      completedAt: "2026-04-19T12:00:01.000Z",
    })

    await storage.claim({
      ...failedDeliveryKey,
      receivedAt: "2026-04-19T12:00:02.000Z",
    })

    await expect(
      storage.fail({
        ...failedDeliveryKey,
        failedAt: "2026-04-19T12:00:03.000Z",
        error: "handler failed",
      })
    ).resolves.toMatchObject({
      ...failedDeliveryKey,
      status: "failed",
      receivedAt: "2026-04-19T12:00:02.000Z",
      failedAt: "2026-04-19T12:00:03.000Z",
      error: "handler failed",
    })
  })
})
