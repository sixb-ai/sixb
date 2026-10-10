import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
  type SixbHostOptions,
} from "@sixb/core"
import { BrokerCursorExpiredError } from "@sixb/core/broker"
import type { DomainEventService, StableEventEnvelope } from "@sixb/core/internal/events"
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

  test("accepts run-scoped subscriptions", () => {
    const result = parseSubscriptionMessage({
      type: "subscribe",
      topic: "syncs",
      types: ["sync.run.finished"],
      runId: "run-1",
    })

    expect(result).toEqual({
      ok: true,
      data: {
        type: "subscribe",
        topic: "syncs",
        types: ["sync.run.finished"],
        runId: "run-1",
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

  test("rejects the actions topic, whose events were removed", () => {
    const result = parseSubscriptionMessage({ type: "subscribe", topic: "actions" })

    expect(result.ok).toBe(false)
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
      { broker: new SlowLatestCursorBroker() }
    )
  })

  test("streams after subscribe and keeps events emitted after open", async () => {
    await withWsServer(async ({ baseUrl, sixb }) => {
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/events`)

      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "events" })

        const [stored] = await (sixb.events as DomainEventService).publishEnvelopes([
          telemetryEnvelope(sixb.id, "fan-1", 1200, "2026-02-18T10:00:10.000Z"),
        ])

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

  test("reports initialization failures and closes the websocket", async () => {
    await withWsServer(
      async ({ baseUrl }) => {
        const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/events`)
        const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()))

        try {
          expect(await nextWsMessage(ws)).toEqual({
            type: "error",
            message: "[SixbServer] Failed to initialize event websocket: latest cursor unavailable",
          })
          await closed
        } finally {
          ws.close()
        }
      },
      { broker: new FailingLatestCursorBroker() }
    )
  })

  test("scopes the stream to one object when objectTypeId/primaryId are set", async () => {
    await withWsServer(async ({ baseUrl, sixb }) => {
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/events`)

      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "events" })

        const [matching] = await (sixb.events as DomainEventService).publishEnvelopes([
          telemetryEnvelope(sixb.id, "fan-1", 1200, "2026-02-18T10:00:10.000Z"),
        ])
        await (sixb.events as DomainEventService).publishEnvelopes([
          telemetryEnvelope(sixb.id, "fan-2", 800, "2026-02-18T10:00:11.000Z"),
        ])

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

  test("scopes run streams by run id", async () => {
    await withWsServer(async ({ baseUrl, sixb }) => {
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/events`)

      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "events" })

        const [matching] = await sixb.events.append({
          events: [
            {
              type: "sync.run.finished",
              payload: { syncId: "import-quotes", runId: "run-1", status: "succeeded" },
            },
          ],
        })
        await sixb.events.append({
          events: [
            {
              type: "sync.run.finished",
              payload: { syncId: "import-quotes", runId: "run-2", status: "succeeded" },
            },
          ],
        })

        ws.send(
          JSON.stringify({
            type: "subscribe",
            topic: "syncs",
            types: ["sync.run.finished"],
            runId: "run-1",
          })
        )

        expect(await nextWsMessage(ws)).toMatchObject({ type: "subscribed" })
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "event",
          event: { cursor: matching?.cursor, payload: { syncId: "import-quotes", runId: "run-1" } },
        })
        await expectNoWsMessage(ws)
      } finally {
        ws.close()
      }
    })
  })

  // Reproduce: restore the per-socket `setInterval` poll of `events.read` in routes/ws/events.ts.
  test("pushes events to every socket from one broker subscription without polling", async () => {
    const broker = new CountingEventsBroker()
    await withWsServer(
      async ({ baseUrl, sixb }) => {
        const sockets: WebSocket[] = []
        try {
          for (const url of [0, 1].map(() => `${baseUrl.replace("http://", "ws://")}/ws/events`)) {
            const ws = new WebSocket(url)
            sockets.push(ws)
            expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "events" })
            ws.send(JSON.stringify({ type: "subscribe", topic: "telemetry" }))
            expect(await nextWsMessage(ws)).toMatchObject({ type: "subscribed" })
          }
          expect(broker.eventSubscriptions).toBe(1)

          await Bun.sleep(50)
          const reads = broker.eventReads
          await expectNoWsMessage(sockets[0] as WebSocket)
          expect(broker.eventReads).toBe(reads)

          const [stored] = await (sixb.events as DomainEventService).publishEnvelopes([
            telemetryEnvelope(sixb.id, "fan-1", 1200, "2026-02-18T10:00:10.000Z"),
          ])
          for (const ws of sockets) {
            expect(await nextWsMessage(ws)).toMatchObject({
              type: "event",
              event: { cursor: stored?.cursor },
            })
          }
        } finally {
          for (const ws of sockets) ws.close()
        }
        const deadline = Date.now() + 1_000
        while (broker.eventSubscriptions > 0 && Date.now() < deadline) await Bun.sleep(5)
        expect(broker.eventSubscriptions).toBe(0)
      },
      { broker }
    )
  })

  // Reproduce: drop the BrokerCursorExpiredError branch from `catchUp` in subscription-hub.ts.
  test("reports an expired cursor once, then keeps streaming live events", async () => {
    await withWsServer(
      async ({ baseUrl, sixb }) => {
        const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/events`)

        try {
          expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "events" })
          ws.send(JSON.stringify({ type: "subscribe", topic: "telemetry", afterCursor: "expired" }))

          expect(await nextWsMessage(ws)).toMatchObject({ type: "subscribed" })
          expect(await nextWsMessage(ws)).toEqual({
            type: "error",
            message:
              "[SixbServer] Event cursor expired; refetch current state. Live events continue.",
          })
          await expectNoWsMessage(ws)

          const [stored] = await (sixb.events as DomainEventService).publishEnvelopes([
            telemetryEnvelope(sixb.id, "fan-1", 1200, "2026-02-18T10:00:10.000Z"),
          ])
          expect(await nextWsMessage(ws)).toMatchObject({
            type: "event",
            event: { cursor: stored?.cursor },
          })
        } finally {
          ws.close()
        }
      },
      { broker: new ExpiredCursorBroker() }
    )
  })
})

function createSixbInstance(options: SixbHostOptions): SixbHost {
  return new SixbHost(options)
}

/** Counts reads of, and live subscriptions to, the domain event stream. */
class CountingEventsBroker extends InMemoryBroker {
  eventReads = 0
  eventSubscriptions = 0

  override async read(params: Parameters<InMemoryBroker["read"]>[0]) {
    if (params.streamId === "__events") this.eventReads += 1
    return super.read(params)
  }

  override async subscribe(
    params: Parameters<InMemoryBroker["subscribe"]>[0],
    handler: Parameters<InMemoryBroker["subscribe"]>[1]
  ): Promise<() => void> {
    const unsubscribe = await super.subscribe(params, handler)
    if (params.streamId !== "__events") return unsubscribe
    this.eventSubscriptions += 1
    let subscribed = true
    return () => {
      if (subscribed) this.eventSubscriptions -= 1
      subscribed = false
      unsubscribe()
    }
  }
}

/** Treats the cursor `expired` as one that retention has already dropped. */
class ExpiredCursorBroker extends InMemoryBroker {
  override async read(params: Parameters<InMemoryBroker["read"]>[0]) {
    if (params.afterCursor === "expired") {
      throw new BrokerCursorExpiredError("Cursor 'expired' is older than the retained range.")
    }
    return super.read(params)
  }
}

class SlowLatestCursorBroker extends InMemoryBroker {
  override async latestCursor(params: Parameters<InMemoryBroker["latestCursor"]>[0]) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    return super.latestCursor(params)
  }
}

class FailingLatestCursorBroker extends InMemoryBroker {
  override async latestCursor(): Promise<string | undefined> {
    throw new Error("latest cursor unavailable")
  }
}

async function withWsServer(
  run: (context: { baseUrl: string; sixb: SixbHost }) => Promise<void>,
  options: { readonly broker?: InMemoryBroker } = {}
): Promise<void> {
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const sixb = createSixbInstance({
    id: "ws-test-project",
    ontology: [],
    broker: options.broker ?? new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  const server = new SixbServer({
    host: sixb,
    hostname: "127.0.0.1",
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

function telemetryEnvelope(
  projectId: string,
  objectId: string,
  value: number,
  at: string
): StableEventEnvelope {
  return {
    id: `telemetry-${objectId}-${at}`,
    schemaVersion: 1,
    projectId,
    occurredAt: at,
    correlationId: `correlation-${objectId}-${at}`,
    origin: { kind: "runtime", requestId: `seed-${objectId}-${at}` },
    executor: { type: "request", requestId: `seed-${objectId}-${at}` },
    commitId: `commit-${objectId}-${at}`,
    commitOrdinal: 0,
    type: "telemetry.appended",
    topic: "telemetry",
    partitionKey: `device:${objectId}:rpm`,
    payload: {
      objectTypeId: "device",
      objectId,
      propertyId: "rpm",
      value,
      at,
    },
  }
}
