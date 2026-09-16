import { describe, expect, test } from "bun:test"
import {
  defineConnector,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createSixbApi, SixbServer } from "../../../packages/server/src/server"
import {
  type MicrosoftEventContext,
  type MicrosoftEventHandler,
  type MicrosoftWebhookEvent,
  microsoft,
} from "../src"

const URL = "http://localhost/api/webhooks/microsoft/events"
const notification = {
  subscriptionId: "subscription",
  tenantId: "tenant",
  clientState: "secret",
  subscriptionExpirationDateTime: "2026-10-01T00:00:00Z",
  changeType: "created",
  resource: "users/u/messages/m",
  resourceData: { id: "m", "@odata.type": "#Microsoft.Graph.Message" },
}

function runtime(onEvent: MicrosoftEventHandler) {
  const storage = new InMemoryStorage()
  const connector = defineConnector(
    "microsoft",
    microsoft({
      auth: { token: () => "token" },
      webhookSecret: "secret",
      onEvent,
    })
  )
  const host = new SixbHost({
    id: "mail-test",
    ontology: [],
    connectors: [connector],
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    onError: () => {},
  })
  const app = createSixbApi(
    new SixbServer({
      host,
      quiet: true,
      browser: {
        publicOrigin: "http://localhost",
        allowedOrigins: [{ origin: "http://atlas.localhost", audience: "atlas" }],
      },
    })
  )
  const deliver = (value: unknown) =>
    app.fetch(
      new Request(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      })
    )
  return { app, deliver, storage }
}

describe("Microsoft webhooks through Sixb", () => {
  // Countercheck: change .raw() to .json() in src/webhooks.ts; the empty handshake returns 400.
  test("answers the URL-decoded validation challenge without auth or a JSON body", async () => {
    let calls = 0
    const { app } = runtime(() => {
      calls++
    })
    const token = "opaque + percent% / token"
    const response = await app.fetch(
      new Request(`${URL}?validationToken=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/plain")
    expect(await response.text()).toBe(token)
    expect(calls).toBe(0)
  })

  test("dispatches mixed change/lifecycle batches with run context and lazy client", async () => {
    const received: MicrosoftEventContext[] = []
    const { deliver, storage } = runtime((context) => {
      received.push(context)
    })
    const response = await deliver({
      value: [
        notification,
        {
          subscriptionId: "other",
          tenantId: "tenant",
          clientState: "secret",
          lifecycleEvent: "missed",
        },
      ],
    })
    expect(response.status).toBe(202)
    expect(received.map((c) => c.event.kind)).toEqual(["change", "lifecycle"])
    expect(received[0].event).toMatchObject({ changeType: "created", resourceData: { id: "m" } })
    expect(received[1].event).toMatchObject({ subscriptionId: "other", lifecycleEvent: "missed" })
    expect(received[0].event).not.toHaveProperty("clientState")
    expect((await received[0].client()).mail).toBeDefined()
    expect(received[0].sixb.execution.id).toBeTruthy()
    const runs = await storage.webhookRuns.list({
      projectId: "mail-test",
      connectorId: "microsoft",
    })
    expect(runs.runs[0].status).toBe("succeeded")
  })

  // Countercheck: remove the clientState comparison in parseNotifications; this admits the batch.
  test("rejects an entire mixed batch before callbacks if any clientState is invalid", async () => {
    const received: MicrosoftWebhookEvent[] = []
    const { deliver, storage } = runtime(({ event }) => {
      received.push(event)
    })
    const response = await deliver({
      value: [notification, { ...notification, clientState: "wrong!" }],
    })
    expect(response.status).toBe(401)
    expect(received).toHaveLength(0)
    expect((await storage.webhookRuns.list({ projectId: "mail-test" })).total).toBe(0)
  })

  test("rejects malformed notifications and missing secrets", async () => {
    const { deliver } = runtime(() => {
      throw new Error("must not run")
    })
    for (const value of [
      {},
      { value: [] },
      { value: [{ ...notification, clientState: undefined }] },
      { value: [{ ...notification, resourceData: { id: 42 } }] },
      { value: [{ ...notification, lifecycleEvent: "invalid" }] },
    ])
      expect((await deliver(value)).status).toBe(401)
  })

  test("awaits durable enqueue, returns 500 on failure, and permits provider replay", async () => {
    let attempts = 0
    const { deliver, storage } = runtime(async () => {
      attempts++
      if (attempts === 1) throw new Error("queue unavailable")
    })
    expect((await deliver({ value: [notification] })).status).toBe(500)
    expect((await deliver({ value: [notification] })).status).toBe(202)
    expect(attempts).toBe(2)
    const runs = await storage.webhookRuns.list({ projectId: "mail-test" })
    expect(runs.runs.map((r) => r.status).sort()).toEqual(["failed", "succeeded"])
  })

  test("does not deduplicate distinct updates to the same resource", async () => {
    let calls = 0
    const { deliver } = runtime(() => {
      calls++
    })
    await deliver({ value: [{ ...notification, changeType: "updated" }] })
    await deliver({ value: [{ ...notification, changeType: "updated" }] })
    expect(calls).toBe(2)
  })

  test("registers the inbound route only when onEvent is configured", () => {
    expect(microsoft({ auth: { token: () => "token" } }).webhooks).toBeUndefined()
  })
})
