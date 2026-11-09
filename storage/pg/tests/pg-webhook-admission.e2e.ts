import { afterEach, describe, expect, test } from "bun:test"
import { type AdmitWebhookRunInput, admitWebhookRun } from "@sixb/core/internal/webhooks"
import type { PostgresStorage } from "../src"
import { createTestStorage, disposeTestStorage } from "./helpers"

const projectId = "webhook-admission"
const storages: PostgresStorage[] = []

afterEach(async () => {
  await Promise.all(storages.splice(0).map(disposeTestStorage))
})

async function storage(): Promise<PostgresStorage> {
  const { storage } = await createTestStorage()
  storages.push(storage)
  return storage
}

function admission(storage: PostgresStorage, runId: string, idempotencyKey: string) {
  const input: AdmitWebhookRunInput = {
    storage,
    projectId,
    runId,
    connectorId: "crm",
    webhookId: "person-updated",
    method: "POST",
    route: "/api/webhooks/crm/person-updated",
    requestBodyBytes: 12,
    requestBodySha256: "0".repeat(64),
    idempotencyKey,
  }

  return admitWebhookRun(input).catch((error) => error)
}

/** As many deliveries at once as the provider's webhooks send in a burst. */
const CONCURRENT = 20

describe("Webhook admission on PostgreSQL", () => {
  // Reproduce: admit in a serializable transaction again in run-admission.ts. Predicate locks on
  // the delivery lookup make distinct deliveries conflict, and some exhaust their attempts.
  test("admits concurrent deliveries with distinct keys, every one", async () => {
    const pg = await storage()

    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, index) =>
        admission(pg, `run-${index}`, `delivery-${index}`)
      )
    )

    expect(results.map((result) => result.status ?? String(result))).toEqual(
      Array.from({ length: CONCURRENT }, () => "admitted")
    )
  })

  test("admits one of concurrent deliveries with the same key, the others find it running", async () => {
    const pg = await storage()

    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, index) =>
        admission(pg, `run-${index}`, "delivery-same")
      )
    )

    const statuses = results.map((result) => result.status ?? String(result))
    expect(statuses.filter((status) => status === "admitted")).toHaveLength(1)
    expect(statuses.filter((status) => status === "in_progress")).toHaveLength(CONCURRENT - 1)
    expect((await pg.webhookRuns.list({ projectId })).total).toBe(1)
  })

  test("restarts a failed delivery once when its retries arrive together", async () => {
    const pg = await storage()
    const first = await admission(pg, "run-first", "delivery-retried")
    await pg.webhookRuns.finish({
      projectId,
      id: first.run.id,
      executionToken: String(first.run.execution?.token),
      status: "failed",
      responseStatus: 503,
      error: {
        code: "webhook.delivery_failed",
        message: "Webhook delivery failed.",
        retryable: true,
        at: "2026-11-05T10:00:00.000Z",
      },
    })

    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, index) =>
        admission(pg, `run-retry-${index}`, "delivery-retried")
      )
    )

    const admitted = results.filter((result) => result.status === "admitted")
    expect(admitted).toHaveLength(1)
    expect(admitted[0]).toMatchObject({ retried: true, run: { id: first.run.id } })
    expect(results.filter((result) => result.status === "in_progress")).toHaveLength(CONCURRENT - 1)
  })
})
