import { describe, expect, test } from "bun:test"
import {
  defineConnector,
  defineWebhook,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  Pario,
  type ParioOptions,
} from "@pario/core"
import { createParioApi, ParioServer } from "../src/server"

function createParioInstance<TOntologySources extends readonly OntologySource[]>(
  options: ParioOptions<TOntologySources>
): Pario<TOntologySources> {
  const ParioConstructor = Pario as unknown as new (
    options: ParioOptions<TOntologySources>
  ) => Pario<TOntologySources>

  return new ParioConstructor(options)
}

describe("webhook routes", () => {
  test("dispatches validated bodies with raw bytes, metadata, and lazy clients", async () => {
    let rawBodyText = ""
    let requestHeader = ""
    let connected = false

    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("events")
          .post()
          .json({
            parse(value: unknown): { name: string } {
              if (!isRecord(value) || typeof value.name !== "string") {
                throw new Error("name is required")
              }

              return { name: value.name }
            },
          })
          .verify(({ request, rawBody }) => {
            requestHeader = request.headers.get("x-provider") ?? ""
            rawBodyText = new TextDecoder().decode(rawBody)
          })
          .handle(async ({ body, client, pario, request, webhook }) => {
            const resolved = (await client()) as { source: string }
            connected = resolved.source === "github"

            return {
              status: 201,
              headers: { "x-webhook": webhook.route },
              body: {
                name: body.name,
                projectId: pario.id,
                requestHeader: request.headers.get("x-provider"),
              },
            }
          }),
      ],
      connect() {
        return { source: "github" }
      },
    })

    const storage = new InMemoryStorage()
    const app = createWebhookApp([connector], storage)
    const payload = JSON.stringify({ name: "issue-opened" })
    const response = await app.fetch(
      new Request("http://localhost/api/webhooks/github/events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-provider": "github" },
        body: payload,
      })
    )

    expect(response.status).toBe(201)
    expect(response.headers.get("x-webhook")).toBe("/api/webhooks/github/events")
    expect(await response.json()).toEqual({
      name: "issue-opened",
      projectId: "test-project",
      requestHeader: "github",
    })
    expect(rawBodyText).toBe(payload)
    expect(requestHeader).toBe("github")
    expect(connected).toBe(true)

    const runs = await storage.webhookRuns.list({
      projectId: "test-project",
      connectorId: "github",
      webhookId: "events",
    })
    const [run] = runs.runs

    expect(runs.total).toBe(1)
    expect(run).toMatchObject({
      connectorId: "github",
      webhookId: "events",
      method: "POST",
      route: "/api/webhooks/github/events",
      status: "succeeded",
      responseStatus: 201,
    })
    expect(run?.requestBodyBytes).toBe(new TextEncoder().encode(payload).byteLength)
  })

  test("returns 400 for body validation failures before handlers run", async () => {
    let calls = 0
    const connector = defineConnector("edge", {
      type: "test",
      webhooks: [
        defineWebhook("telemetry")
          .post()
          .json({
            parse(value: unknown): { value: number } {
              if (!isRecord(value) || typeof value.value !== "number") {
                throw new Error("value must be a number")
              }

              return { value: value.value }
            },
          })
          .handle(() => {
            calls += 1
          }),
      ],
      connect() {
        return {}
      },
    })

    const storage = new InMemoryStorage()
    const app = createWebhookApp([connector], storage)
    const payload = JSON.stringify({ value: "hot" })
    const response = await app.fetch(
      new Request("http://localhost/api/webhooks/edge/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "value must be a number" })
    expect(calls).toBe(0)

    const runs = await storage.webhookRuns.list({ projectId: "test-project" })
    const [run] = runs.runs

    expect(runs.total).toBe(1)
    expect(run).toMatchObject({
      connectorId: "edge",
      webhookId: "telemetry",
      status: "failed",
      responseStatus: 400,
      error: "value must be a number",
    })
    expect(run?.requestBodyBytes).toBe(new TextEncoder().encode(payload).byteLength)
  })

  test("skips duplicate idempotent deliveries before handlers run", async () => {
    let calls = 0
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("events")
          .post()
          .json()
          .idempotencyKey(({ request }) => request.headers.get("x-github-delivery"))
          .handle(() => {
            calls += 1
          }),
      ],
      connect() {
        return {}
      },
    })

    const storage = new InMemoryStorage()
    const app = createWebhookApp([connector], storage)
    const request = () =>
      new Request("http://localhost/api/webhooks/github/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "delivery-1",
        },
        body: JSON.stringify({ ok: true }),
      })

    const first = await app.fetch(request())
    const second = await app.fetch(request())

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(calls).toBe(1)

    const runs = await storage.webhookRuns.list({
      projectId: "test-project",
      connectorId: "github",
      webhookId: "events",
      order: "asc",
    })
    const succeeded = runs.runs.find((run) => run.status === "succeeded")
    const skipped = runs.runs.find((run) => run.status === "skipped")

    expect(runs.total).toBe(2)
    expect(succeeded).toMatchObject({
      responseStatus: 202,
      idempotencyKey: "delivery-1",
      deliveryClaimResult: "claimed",
    })
    expect(skipped).toMatchObject({
      responseStatus: 202,
      idempotencyKey: "delivery-1",
      deliveryClaimResult: "duplicate",
    })

    const listResponse = await app.fetch(
      new Request(
        "http://localhost/api/webhook-runs?connectorId=github&webhookId=events&status=skipped&idempotencyKey=delivery-1"
      )
    )
    const listBody = (await listResponse.json()) as {
      runs: Array<{
        status: string
        connectorId: string
        webhookId: string
        idempotencyKey?: string
        deliveryClaimResult?: string
      }>
      total: number
      hasMore: boolean
    }

    expect(listResponse.status).toBe(200)
    expect(listBody).toMatchObject({
      total: 1,
      hasMore: false,
      runs: [
        {
          connectorId: "github",
          webhookId: "events",
          status: "skipped",
          idempotencyKey: "delivery-1",
          deliveryClaimResult: "duplicate",
        },
      ],
    })
  })

  test("maps unknown, unsupported, verification, and handler errors", async () => {
    const connector = defineConnector("github", {
      type: "test",
      webhooks: [
        defineWebhook("events")
          .post()
          .text()
          .verify(() => {
            throw new Error("bad signature")
          })
          .handle(() => {
            throw new Error("should not run")
          }),
        defineWebhook("failing")
          .post()
          .text()
          .handle(() => {
            throw new Error("boom")
          }),
      ],
      connect() {
        return {}
      },
    })

    const storage = new InMemoryStorage()
    const app = createWebhookApp([connector], storage)

    const unknown = await app.fetch(
      new Request("http://localhost/api/webhooks/github/missing", { method: "POST" })
    )
    const unsupported = await app.fetch(
      new Request("http://localhost/api/webhooks/github/events", { method: "GET" })
    )
    const unauthorized = await app.fetch(
      new Request("http://localhost/api/webhooks/github/events", {
        method: "POST",
        body: "hello",
      })
    )
    const failed = await app.fetch(
      new Request("http://localhost/api/webhooks/github/failing", {
        method: "POST",
        body: "hello",
      })
    )

    expect(unknown.status).toBe(404)
    expect(unsupported.status).toBe(405)
    expect(unsupported.headers.get("allow")).toBe("POST")
    expect(unauthorized.status).toBe(401)
    expect(failed.status).toBe(500)

    const runs = await storage.webhookRuns.list({ projectId: "test-project" })

    expect(runs.total).toBe(3)
    expect(runs.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          webhookId: "events",
          method: "GET",
          status: "failed",
          responseStatus: 405,
          error: "Method not allowed",
        }),
        expect.objectContaining({
          webhookId: "events",
          method: "POST",
          status: "failed",
          responseStatus: 401,
          error: "Webhook verification failed",
        }),
        expect.objectContaining({
          webhookId: "failing",
          method: "POST",
          status: "failed",
          responseStatus: 500,
          error: "Webhook handler failed",
        }),
      ])
    )
  })
})

function createWebhookApp(
  connectors: ParioOptions<readonly OntologySource[]>["connectors"],
  storage = new InMemoryStorage()
) {
  const pario = createParioInstance<readonly OntologySource[]>({
    id: "test-project",
    ontology: [],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    connectors,
  })
  const server = new ParioServer({ pario, quiet: true, ui: false })
  return createParioApi(server)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
