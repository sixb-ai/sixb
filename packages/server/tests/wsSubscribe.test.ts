import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  Sixb,
  type SixbOptions,
} from "@sixb/core"
import { parseSubscriptionMessage } from "../src/routes/ws/events"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const WORKFLOW_EVENT_TYPES = [
  "workflow.run.queued",
  "workflow.run.started",
  "workflow.run.node.started",
  "workflow.run.node.finished",
  "workflow.run.finished",
] as const

describe("parseSubscriptionMessage", () => {
  test("accepts a valid subscribe message", () => {
    const result = parseSubscriptionMessage({
      type: "subscribe",
      topic: "telemetry",
      types: ["telemetry.appended"],
      afterCursor: "10",
      limit: 50,
    })

    expect(result).toEqual({
      ok: true,
      data: {
        type: "subscribe",
        topic: "telemetry",
        types: ["telemetry.appended"],
        afterCursor: "10",
        limit: 50,
      },
    })
  })

  test("accepts workflow event subscriptions", () => {
    const result = parseSubscriptionMessage({
      type: "subscribe",
      topic: "workflows",
      types: [...WORKFLOW_EVENT_TYPES],
    })

    expect(result).toEqual({
      ok: true,
      data: {
        type: "subscribe",
        topic: "workflows",
        types: [...WORKFLOW_EVENT_TYPES],
      },
    })
  })

  test("accepts object-scoped subscriptions", () => {
    const result = parseSubscriptionMessage({
      type: "subscribe",
      topic: "telemetry",
      objectTypeId: "device",
      primaryId: "fan-1",
    })

    expect(result).toEqual({
      ok: true,
      data: {
        type: "subscribe",
        topic: "telemetry",
        objectTypeId: "device",
        primaryId: "fan-1",
      },
    })
  })

  test("accepts action-scoped subscriptions", () => {
    const result = parseSubscriptionMessage({
      type: "subscribe",
      topic: "actions",
      types: ["action.completed", "action.failed"],
      actionId: "approveQuote",
      runId: "act-1",
      objectTypeId: "Quote",
      primaryId: "q_123",
    })

    expect(result).toEqual({
      ok: true,
      data: {
        type: "subscribe",
        topic: "actions",
        types: ["action.completed", "action.failed"],
        actionId: "approveQuote",
        runId: "act-1",
        objectTypeId: "Quote",
        primaryId: "q_123",
      },
    })
  })

  test("rejects non-object payloads", () => {
    const result = parseSubscriptionMessage("subscribe")

    expect(result).toEqual({
      ok: false,
      error: "Message must be a JSON object.",
    })
  })

  test("rejects invalid topic values", () => {
    const result = parseSubscriptionMessage({
      type: "subscribe",
      topic: "invalid-topic",
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("Expected invalid subscription message")
    }

    expect(result.error).toContain("Invalid input")
  })

  test("accepts unsubscribe messages", () => {
    const result = parseSubscriptionMessage({ type: "unsubscribe" })

    expect(result).toEqual({
      ok: true,
      data: { type: "unsubscribe" },
    })
  })
})

describe("/ws/events subscriptions", () => {
  test("accepts an immediate subscription while the initial cursor is loading", async () => {
    await withWsServer(
      async ({ baseUrl }) => {
        const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/events`)

        try {
          const messages = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
            const received: Record<string, unknown>[] = []
            const timeout = setTimeout(
              () => reject(new Error("Timed out waiting for subscribe")),
              3_000
            )

            ws.addEventListener("open", () => {
              ws.send(JSON.stringify({ type: "subscribe", topic: "objects" }))
            })
            ws.addEventListener("message", (event) => {
              const message = JSON.parse(decodeWsData(event.data)) as Record<string, unknown>
              received.push(message)
              if (message.type === "error") {
                clearTimeout(timeout)
                reject(new Error(String(message.message)))
              } else if (message.type === "subscribed") {
                clearTimeout(timeout)
                resolve(received)
              }
            })
            ws.addEventListener("error", () => {
              clearTimeout(timeout)
              reject(new Error("WebSocket error"))
            })
          })

          expect(messages.map((message) => message.type)).toContain("connected")
          expect(messages.map((message) => message.type)).toContain("subscribed")
        } finally {
          ws.close()
        }
      },
      { broker: new SlowReadBroker() }
    )
  })

  test("streams after subscribe and keeps events emitted after open", async () => {
    await withWsServer(async ({ baseUrl, sixb }) => {
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/events`)

      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "events" })

        const [stored] = await sixb.events.append({
          events: [
            {
              type: "telemetry.appended",
              payload: {
                objectTypeId: "device",
                objectId: "fan-1",
                propertyId: "rpm",
                value: 1200,
                at: "2026-02-18T10:00:10.000Z",
              },
            },
          ],
        })

        await expectNoWsMessage(ws)

        ws.send(
          JSON.stringify({
            type: "subscribe",
            topic: "telemetry",
            types: ["telemetry.appended"],
          })
        )

        expect(await nextWsMessage(ws)).toMatchObject({
          type: "subscribed",
          topic: "telemetry",
          types: ["telemetry.appended"],
        })
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "event",
          event: {
            cursor: stored?.cursor,
            type: "telemetry.appended",
            topic: "telemetry",
          },
        })
      } finally {
        ws.close()
      }
    })
  })

  test("scopes the stream to one object when objectTypeId/primaryId are set", async () => {
    await withWsServer(async ({ baseUrl, sixb }) => {
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/events`)

      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "events" })

        const [matching] = await sixb.events.append({
          events: [
            {
              type: "telemetry.appended",
              payload: {
                objectTypeId: "device",
                objectId: "fan-1",
                propertyId: "rpm",
                value: 1200,
                at: "2026-02-18T10:00:10.000Z",
              },
            },
          ],
        })
        await sixb.events.append({
          events: [
            {
              type: "telemetry.appended",
              payload: {
                objectTypeId: "device",
                objectId: "fan-2",
                propertyId: "rpm",
                value: 800,
                at: "2026-02-18T10:00:11.000Z",
              },
            },
          ],
        })

        ws.send(
          JSON.stringify({
            type: "subscribe",
            topic: "telemetry",
            types: ["telemetry.appended"],
            objectTypeId: "device",
            primaryId: "fan-1",
          })
        )

        expect(await nextWsMessage(ws)).toMatchObject({ type: "subscribed" })
        // Only the fan-1 event is delivered; fan-2 is filtered server-side.
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "event",
          event: { cursor: matching?.cursor, payload: { objectId: "fan-1" } },
        })
        await expectNoWsMessage(ws)
      } finally {
        ws.close()
      }
    })
  })

  test("scopes action streams by run, action id and object subject", async () => {
    await withWsServer(async ({ baseUrl, sixb }) => {
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/events`)

      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "events" })

        const [matching] = await sixb.events.append({
          events: [
            {
              type: "action.completed",
              payload: {
                actionId: "approveQuote",
                runId: "act-1",
                subject: { kind: "object", objectTypeId: "Quote", primaryId: "q_123" },
                finishedAt: "2026-02-18T10:00:10.000Z",
              },
            },
          ],
        })
        await sixb.events.append({
          events: [
            {
              type: "action.completed",
              payload: {
                actionId: "approveQuote",
                runId: "act-2",
                subject: { kind: "object", objectTypeId: "Quote", primaryId: "q_123" },
                finishedAt: "2026-02-18T10:00:11.000Z",
              },
            },
            {
              type: "action.completed",
              payload: {
                actionId: "rejectQuote",
                runId: "act-1",
                subject: { kind: "object", objectTypeId: "Quote", primaryId: "q_123" },
                finishedAt: "2026-02-18T10:00:12.000Z",
              },
            },
            {
              type: "action.completed",
              payload: {
                actionId: "approveQuote",
                runId: "act-1",
                subject: { kind: "object", objectTypeId: "Quote", primaryId: "q_999" },
                finishedAt: "2026-02-18T10:00:13.000Z",
              },
            },
          ],
        })

        ws.send(
          JSON.stringify({
            type: "subscribe",
            topic: "actions",
            types: ["action.completed"],
            actionId: "approveQuote",
            runId: "act-1",
            objectTypeId: "Quote",
            primaryId: "q_123",
          })
        )

        expect(await nextWsMessage(ws)).toMatchObject({ type: "subscribed" })
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "event",
          event: {
            cursor: matching?.cursor,
            payload: { actionId: "approveQuote", runId: "act-1" },
          },
        })
        await expectNoWsMessage(ws)
      } finally {
        ws.close()
      }
    })
  })
})

function createSixbInstance<TOntologySources extends readonly OntologySource[]>(
  options: SixbOptions<TOntologySources>
): Sixb<TOntologySources> {
  const SixbConstructor = Sixb as unknown as new (
    options: SixbOptions<TOntologySources>
  ) => Sixb<TOntologySources>

  return new SixbConstructor(options)
}

class SlowReadBroker extends InMemoryBroker {
  override async read(params: Parameters<InMemoryBroker["read"]>[0]) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    return super.read(params)
  }
}

async function withWsServer(
  run: (context: { baseUrl: string; sixb: Sixb<readonly OntologySource[]> }) => Promise<void>,
  options: { readonly broker?: InMemoryBroker } = {}
): Promise<void> {
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const sixb = createSixbInstance<readonly OntologySource[]>({
    id: "ws-test-project",
    ontology: [],
    broker: options.broker ?? new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  const server = new SixbServer({
    sixb,
    host: "127.0.0.1",
    port,
    quiet: true,
    browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
  })

  await server.start()
  try {
    await run({ baseUrl, sixb })
  } finally {
    await server.stop()
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer() as ReturnType<typeof createServer> & {
      on(event: string, listener: (error: Error) => void): void
    }
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }

      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(address.port)
      })
    })
  })
}

async function nextWsMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("Timed out waiting for websocket message"))
    }, timeoutMs)

    const onMessage = (event: MessageEvent) => {
      cleanup()
      try {
        resolvePromise(JSON.parse(decodeWsData(event.data)) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    }
    const onError = () => {
      cleanup()
      reject(new Error("WebSocket error"))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("error", onError)
    }

    ws.addEventListener("message", onMessage)
    ws.addEventListener("error", onError)
  })
}

async function expectNoWsMessage(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolvePromise()
    }, 650)

    const onMessage = (event: MessageEvent) => {
      cleanup()
      reject(new Error(`Unexpected websocket message: ${decodeWsData(event.data)}`))
    }
    const onError = () => {
      cleanup()
      reject(new Error("WebSocket error"))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("error", onError)
    }

    ws.addEventListener("message", onMessage)
    ws.addEventListener("error", onError)
  })
}

function decodeWsData(value: unknown): string {
  if (typeof value === "string") {
    return value
  }

  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(value)
  }

  return String(value)
}
