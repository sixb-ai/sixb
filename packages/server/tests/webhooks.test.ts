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

    const app = createWebhookApp([connector])
    const response = await app.fetch(
      new Request("http://localhost/api/webhooks/github/events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-provider": "github" },
        body: JSON.stringify({ name: "issue-opened" }),
      })
    )

    expect(response.status).toBe(201)
    expect(response.headers.get("x-webhook")).toBe("/api/webhooks/github/events")
    expect(await response.json()).toEqual({
      name: "issue-opened",
      projectId: "test-project",
      requestHeader: "github",
    })
    expect(rawBodyText).toBe(JSON.stringify({ name: "issue-opened" }))
    expect(requestHeader).toBe("github")
    expect(connected).toBe(true)
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

    const app = createWebhookApp([connector])
    const response = await app.fetch(
      new Request("http://localhost/api/webhooks/edge/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "hot" }),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "value must be a number" })
    expect(calls).toBe(0)
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

    const app = createWebhookApp([connector])
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

    const app = createWebhookApp([connector])

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
  })
})

function createWebhookApp(connectors: ParioOptions<readonly OntologySource[]>["connectors"]) {
  const pario = createParioInstance<readonly OntologySource[]>({
    id: "test-project",
    ontology: [],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
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
