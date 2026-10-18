import { afterEach, describe, expect, jest, test } from "bun:test"
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
import { createTestBrowserPolicy, getFreePort, nextWsMessage } from "./helpers"

const WORKFLOW_EVENT_TYPES = [
  "workflow.run.queued",
  "workflow.run.started",
  "workflow.run.node.started",
  "workflow.run.node.finished",
  "workflow.run.finished",
] as const

describe("parseSubscriptionMessage", () => {
  test.each([
    {
      type: "subscribe",
      topic: "telemetry",
      types: ["telemetry.appended"],
      afterCursor: "10",
      limit: 50,
    },
    { type: "subscribe", topic: "workflows", types: [...WORKFLOW_EVENT_TYPES] },
    { type: "subscribe", topic: "telemetry", objectTypeId: "device", primaryId: "fan-1" },
    { type: "subscribe", topic: "syncs", types: ["sync.run.finished"], runId: "run-1" },
    { type: "unsubscribe" },
  ])("accepts %j", (message) => {
    const parsed: unknown = parseSubscriptionMessage(message)
    expect(parsed).toEqual({ ok: true, data: message })
  })

  test("rejects non-objects, unknown topics, and the removed actions topic", () => {
    expect(parseSubscriptionMessage("subscribe")).toEqual({
      ok: false,
      error: "Message must be a JSON object.",
    })
    expect(parseSubscriptionMessage({ type: "subscribe", topic: "invalid-topic" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid input"),
    })
    expect(parseSubscriptionMessage({ type: "subscribe", topic: "actions" }).ok).toBe(false)
  })
})

describe("/ws/events subscriptions", () => {
  // A fake-timer test that times out skips its `finally`.
  afterEach(() => jest.useRealTimers())

  test("accepts an immediate subscription while the initial cursor is loading", async () => {
    const broker = new GatedLatestCursorBroker()
    await withWsServer(
      async ({ baseUrl }) => {
        const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/events`)

        try {
          const barrier = nextWsMessage(ws)
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ type: "subscribe", topic: "objects" }))
            ws.send("not json")
          })
          // The socket handles messages in order, so the reply to the second proves the subscribe
          // arrived while the cursor was still loading.
          expect(await barrier).toEqual({
            type: "error",
            message: "Message must be a JSON object.",
          })

          broker.releaseLatestCursor()
          expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "events" })
          expect(await nextWsMessage(ws)).toMatchObject({ type: "subscribed", topic: "objects" })
        } finally {
          ws.close()
        }
      },
      { broker }
    )
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

        await (sixb.events as DomainEventService).publishEnvelopes([
          telemetryEnvelope(sixb.id, "fan-2", 800, "2026-02-18T10:00:10.000Z"),
        ])
        const [matching] = await (sixb.events as DomainEventService).publishEnvelopes([
          telemetryEnvelope(sixb.id, "fan-1", 1200, "2026-02-18T10:00:11.000Z"),
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
        // The replay is ordered, so fan-1 arriving first proves the earlier fan-2 event was
        // filtered server-side.
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "event",
          event: { cursor: matching?.cursor, payload: { objectId: "fan-1" } },
        })
      } finally {
        ws.close()
      }
    })
  })

  // Reproduce: make `open()` in routes/ws/events.ts subscribe the socket to every event.
  test("scopes run streams by run id", async () => {
    await withWsServer(async ({ baseUrl, sixb }) => {
      const ws = new WebSocket(`${baseUrl.replace("http://", "ws://")}/ws/events`)

      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "events" })

        jest.useFakeTimers()
        await sixb.events.append({
          events: [
            {
              type: "sync.run.finished",
              payload: { syncId: "import-quotes", runId: "run-2", status: "succeeded" },
            },
          ],
        })
        const [matching] = await sixb.events.append({
          events: [
            {
              type: "sync.run.finished",
              payload: { syncId: "import-quotes", runId: "run-1", status: "succeeded" },
            },
          ],
        })
        // Nothing is pushed before the subscription. Run past the hub's flush delay: an event
        // pushed to the unsubscribed socket would now be sent, ahead of this message's reply.
        jest.advanceTimersByTime(50)
        jest.useRealTimers()
        ws.send("not json")
        expect(await nextWsMessage(ws)).toEqual({
          type: "error",
          message: "Message must be a JSON object.",
        })

        ws.send(
          JSON.stringify({
            type: "subscribe",
            topic: "syncs",
            types: ["sync.run.finished"],
            runId: "run-1",
          })
        )

        // The events written since the socket opened are replayed after the acknowledgement.
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "subscribed",
          topic: "syncs",
          types: ["sync.run.finished"],
        })
        // The earlier run-2 event is filtered out, so the run-1 event is the first one sent.
        expect(await nextWsMessage(ws)).toMatchObject({
          type: "event",
          event: { cursor: matching?.cursor, payload: { syncId: "import-quotes", runId: "run-1" } },
        })
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
        // Fake time before the sockets subscribe, so a poll they start would run on it.
        jest.useFakeTimers()
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

          // One replay read per socket; a minute of idle time reads nothing more.
          expect(broker.eventReads).toBe(2)
          jest.advanceTimersByTime(60_000)
          expect(broker.eventReads).toBe(2)

          const [stored] = await (sixb.events as DomainEventService).publishEnvelopes([
            telemetryEnvelope(sixb.id, "fan-1", 1200, "2026-02-18T10:00:10.000Z"),
          ])
          const delivered = sockets.map((ws) => nextWsMessage(ws))
          jest.advanceTimersByTime(10)
          for (const message of await Promise.all(delivered)) {
            expect(message).toMatchObject({ type: "event", event: { cursor: stored?.cursor } })
          }
          expect(broker.eventReads).toBe(2)
        } finally {
          jest.useRealTimers()
          for (const ws of sockets) ws.close()
        }
        await broker.released
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

          // Reported once: the live event is the next message on the still-open socket.
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
  private readonly lastRelease = Promise.withResolvers<void>()
  /** Settles when the last live subscription to the event stream is released. */
  readonly released = this.lastRelease.promise

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
      if (this.eventSubscriptions === 0) this.lastRelease.resolve()
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

/** Holds the cursor a socket loads on open until the test releases it. */
class GatedLatestCursorBroker extends InMemoryBroker {
  private readonly gate = Promise.withResolvers<void>()

  releaseLatestCursor(): void {
    this.gate.resolve()
  }

  override async latestCursor(params: Parameters<InMemoryBroker["latestCursor"]>[0]) {
    await this.gate.promise
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
    browser: createTestBrowserPolicy({ apiOrigin: baseUrl, appOrigin: baseUrl }),
  })

  await server.start()
  try {
    await run({ baseUrl, sixb })
  } finally {
    await server.stop()
  }
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
