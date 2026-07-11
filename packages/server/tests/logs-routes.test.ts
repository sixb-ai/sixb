import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  type AuthorizationContext,
  type BrokerRecord,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LogRunRef,
  noopLoggerProvider,
  type OntologySource,
  Sixb,
  type SixbOptions,
} from "@sixb/core"
import { Elysia } from "elysia"
import { LogStreamTicketStore } from "../src/auth/log-stream-tickets"
import { registerLogRoutes } from "../src/routes/logs"
import { parseLogSubscriptionMessage } from "../src/routes/ws/logs"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

describe("parseLogSubscriptionMessage", () => {
  test("accepts a kind-, level-, and run-scoped message", () => {
    expect(
      parseLogSubscriptionMessage({
        type: "subscribe",
        kinds: ["workflow"],
        levels: ["warn", "error"],
        run: { kind: "workflow", id: "wf-1" },
        afterCursor: "10",
      })
    ).toEqual({
      ok: true,
      data: {
        type: "subscribe",
        kinds: ["workflow"],
        levels: ["warn", "error"],
        run: { kind: "workflow", id: "wf-1" },
        afterCursor: "10",
      },
    })
  })

  test("rejects mismatched kind and run scopes", () => {
    expect(
      parseLogSubscriptionMessage({
        type: "subscribe",
        kinds: ["pipeline"],
        run: { kind: "workflow", id: "wf-1" },
      }).ok
    ).toBe(false)
  })

  test("accepts unsubscribe and rejects invalid payloads", () => {
    expect(parseLogSubscriptionMessage({ type: "unsubscribe" })).toEqual({
      ok: true,
      data: { type: "unsubscribe" },
    })
    expect(parseLogSubscriptionMessage("subscribe")).toEqual({
      ok: false,
      error: "Message must be a JSON object.",
    })
    expect(parseLogSubscriptionMessage({ type: "subscribe", kinds: ["nope"] }).ok).toBe(false)
  })
})

describe("LogStreamTicketStore", () => {
  test("issues opaque, single-use tickets and rejects expired tickets", async () => {
    const store = new LogStreamTicketStore(5, 2)
    const first = store.issue(null)
    const request = ticketRequest(first.ticket)

    expect(store.consume(request)).toEqual({ ticket: first.ticket, authz: null })
    expect(store.consume(request)).toBeNull()

    const expired = store.issue(null)
    store.issue(null)
    expect(() => store.issue(null)).toThrow("Too many outstanding log stream tickets")
    await Bun.sleep(10)
    expect(store.consume(ticketRequest(expired.ticket))).toBeNull()
  })
})

describe("GET /api/logs", () => {
  test("returns pages, enforces kind+run, level, and recent-history semantics", async () => {
    await withServer(async ({ baseUrl, sixb }) => {
      await seed(sixb, { kind: "sync", id: "s1" }, "sync debug", "debug")
      await seed(sixb, { kind: "workflow", id: "w1" }, "workflow info", "info")
      await seed(sixb, { kind: "workflow", id: "w2" }, "workflow error", "error")

      const all = await readLogs(baseUrl)
      expect(all.lines.map((line) => line.message)).toEqual([
        "sync debug",
        "workflow info",
        "workflow error",
      ])
      expect(all.hasMore).toBe(false)

      const one = await readLogs(baseUrl, { kind: "workflow", runId: "w2" })
      expect(one.lines.map((line) => line.message)).toEqual(["workflow error"])
      expect(one.lines[0]?.context.run).toEqual({ kind: "workflow", id: "w2" })

      const errors = await readLogs(baseUrl, { level: "error" })
      expect(errors.lines.map((line) => line.message)).toEqual(["workflow error"])

      const recent = await readLogs(baseUrl, { direction: "backward", limit: "2" })
      expect(recent.lines.map((line) => line.message)).toEqual(["workflow info", "workflow error"])
      expect(recent.hasMore).toBe(true)

      const invalid = await fetch(`${baseUrl}/api/logs?runId=w2`)
      expect(invalid.status).toBe(422)
    })
  })

  test("requires observe:logs for history and ticket issuance", async () => {
    const sixb = createTestSixb()
    const denied = logRoutesWithAuthz(sixb, authzWithoutLogs())
    expect((await denied.handle(new Request("http://localhost/api/logs"))).status).toBe(403)
    expect(
      (
        await denied.handle(
          new Request("http://localhost/api/logs/stream-ticket", { method: "POST" })
        )
      ).status
    ).toBe(403)

    const allowed = logRoutesWithAuthz(sixb, authzWithLogs())
    expect((await allowed.handle(new Request("http://localhost/api/logs"))).status).toBe(200)
    expect(
      (
        await allowed.handle(
          new Request("http://localhost/api/logs/stream-ticket", { method: "POST" })
        )
      ).status
    ).toBe(200)
  })
})

describe("/ws/logs", () => {
  test("requires a ticket, batches lines, filters server-side, and rejects ticket reuse", async () => {
    await withServer(async ({ baseUrl, sixb }) => {
      await expectWsRejected(new WebSocket(wsUrl(baseUrl)))

      const ticket = await issueTicket(baseUrl)
      const ws = new WebSocket(wsUrl(baseUrl), [ticket])
      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "logs" })
        expect(ws.protocol).toBe(ticket)

        ws.send(
          JSON.stringify({
            type: "subscribe",
            run: { kind: "pipeline", id: "p1" },
            levels: ["info", "warn", "error"],
          })
        )
        expect(await nextWsMessage(ws)).toMatchObject({ type: "subscribed" })

        await seed(sixb, { kind: "pipeline", id: "p2" }, "other run", "error")
        await seed(sixb, { kind: "pipeline", id: "p1" }, "below floor", "debug")
        await seed(sixb, { kind: "pipeline", id: "p1" }, "kept one", "info")
        await seed(sixb, { kind: "pipeline", id: "p1" }, "kept two", "error")

        const frame = await nextWsMessage(ws)
        expect(frame.type).toBe("logs")
        expect((frame.logs as Array<{ message: string }>).map((line) => line.message)).toEqual([
          "kept one",
          "kept two",
        ])
        await expectNoWsMessage(ws)
      } finally {
        ws.close()
      }

      await expectWsRejected(new WebSocket(wsUrl(baseUrl), [ticket]))
    })
  })

  test("checks observe:logs again when consuming an authorized ticket", async () => {
    await withServer(async ({ baseUrl, server }) => {
      const denied = server.issueLogStreamTicket(authzWithoutLogs()).ticket
      const ws = new WebSocket(wsUrl(baseUrl), [denied])
      const close = await nextWsClose(ws)
      expect(close.code).toBe(1008)
      expect(close.reason).toContain("observe:logs")
    })
  })

  test("replays from a cursor and multiplexes clients over one broker subscription", async () => {
    const broker = new CountingBroker()
    await withServer(
      async ({ baseUrl, sixb }) => {
        await seed(sixb, { kind: "workflow", id: "w1" }, "before cursor", "info")
        const cursor = (await readLogs(baseUrl)).lines.at(-1)
        if (!cursor) throw new Error("expected a cursor")
        await seed(sixb, { kind: "workflow", id: "w1" }, "after cursor", "info")

        const first = new WebSocket(wsUrl(baseUrl), [await issueTicket(baseUrl)])
        const firstConnected = nextWsMessage(first)
        const second = new WebSocket(wsUrl(baseUrl), [await issueTicket(baseUrl)])
        const secondConnected = nextWsMessage(second)
        try {
          await Promise.all([firstConnected, secondConnected])
          first.send(
            JSON.stringify({
              type: "subscribe",
              run: { kind: "workflow", id: "w1" },
              afterCursor: cursor.cursor,
            })
          )
          second.send(JSON.stringify({ type: "subscribe" }))

          expect(await nextWsMessage(first)).toMatchObject({ type: "subscribed" })
          expect(await nextWsMessage(second)).toMatchObject({ type: "subscribed" })
          expect(await nextWsMessage(first)).toMatchObject({
            type: "logs",
            logs: [{ message: "after cursor" }],
          })
          expect(broker.subscriptionCount).toBe(1)
        } finally {
          first.close()
          second.close()
        }
      },
      { broker }
    )
  })
})

interface LogsResponse {
  count: number
  cursor?: string
  hasMore: boolean
  lines: Array<{
    message: string
    cursor: string
    context: { run: { kind: string; id: string } }
  }>
}

async function readLogs(
  baseUrl: string,
  query: Record<string, string> = {}
): Promise<LogsResponse> {
  const url = new URL(`${baseUrl}/api/logs`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await fetch(url)
  expect(response.ok).toBe(true)
  return (await response.json()) as LogsResponse
}

async function issueTicket(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/logs/stream-ticket`, { method: "POST" })
  expect(response.ok).toBe(true)
  return ((await response.json()) as { ticket: string }).ticket
}

async function seed(
  sixb: Sixb<readonly OntologySource[]>,
  run: LogRunRef,
  message: string,
  level: "debug" | "info" | "warn" | "error"
): Promise<void> {
  const session = sixb.logs.startExecution(run)
  session.logger[level](message)
  await session.flush()
}

function createSixbInstance<TOntologySources extends readonly OntologySource[]>(
  options: SixbOptions<TOntologySources>
): Sixb<TOntologySources> {
  const SixbConstructor = Sixb as unknown as new (
    options: SixbOptions<TOntologySources>
  ) => Sixb<TOntologySources>
  return new SixbConstructor(options)
}

async function withServer(
  run: (context: {
    baseUrl: string
    sixb: Sixb<readonly OntologySource[]>
    server: SixbServer
  }) => Promise<void>,
  options: { readonly broker?: InMemoryBroker } = {}
): Promise<void> {
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const sixb = createTestSixb(options.broker)
  const server = new SixbServer({
    sixb,
    host: "127.0.0.1",
    port,
    quiet: true,
    browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
  })

  await server.start()
  try {
    await run({ baseUrl, sixb, server })
  } finally {
    await server.stop()
  }
}

function createTestSixb(
  broker: InMemoryBroker = new InMemoryBroker()
): Sixb<readonly OntologySource[]> {
  return createSixbInstance<readonly OntologySource[]>({
    id: "logs-test-project",
    ontology: [],
    broker,
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    observability: { logs: { level: "debug" } },
    logger: noopLoggerProvider,
  })
}

class CountingBroker extends InMemoryBroker {
  subscriptionCount = 0

  override async subscribe(
    params: Parameters<InMemoryBroker["subscribe"]>[0],
    handler: (records: readonly BrokerRecord[]) => void
  ): Promise<() => void> {
    this.subscriptionCount += 1
    return super.subscribe(params, handler)
  }
}

function authzWithoutLogs(): AuthorizationContext {
  return {
    principal: { type: "user", id: "u1" },
    groupIds: [],
    roleIds: [],
    grants: {
      "view:object": new Set(),
      "view:dataset": new Set(),
      "apply:action": new Set(),
      "run:workflow": new Set(),
      "run:sync": new Set(),
      "run:pipeline": new Set(),
      "run:agent": new Set(),
      "observe:logs": new Set(),
    },
  }
}

function authzWithLogs(): AuthorizationContext {
  const authz = authzWithoutLogs()
  return {
    ...authz,
    grants: { ...authz.grants, "observe:logs": new Set(["logs"]) },
  }
}

function logRoutesWithAuthz(sixb: Sixb<readonly OntologySource[]>, authz: AuthorizationContext) {
  const app = new Elysia().derive(() => ({ authz, scoped: sixb.as(authz) }))
  return registerLogRoutes(app as unknown as Elysia, sixb, () => ({
    ticket: "sixb.logs.ticket.test",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  }))
}

function ticketRequest(ticket: string): Request {
  return new Request("http://localhost/ws/logs", {
    headers: { "sec-websocket-protocol": ticket },
  })
}

function wsUrl(baseUrl: string): string {
  return `${baseUrl.replace("http://", "ws://")}/ws/logs`
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
      server.close((error) => (error ? reject(error) : resolvePromise(address.port)))
    })
  })
}

async function nextWsMessage(ws: WebSocket, timeoutMs = 3_000): Promise<Record<string, unknown>> {
  return await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("Timed out waiting for websocket message"))
    }, timeoutMs)
    const onMessage = (event: MessageEvent) => {
      cleanup()
      try {
        resolvePromise(JSON.parse(String(event.data)) as Record<string, unknown>)
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

async function nextWsClose(ws: WebSocket): Promise<CloseEvent> {
  return await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for websocket close")),
      3_000
    )
    ws.addEventListener("close", (event) => {
      clearTimeout(timeout)
      resolvePromise(event)
    })
    ws.addEventListener("error", () => {
      // A failed handshake may emit error before close; close carries the policy result.
    })
  })
}

async function expectWsRejected(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for websocket rejection")),
      3_000
    )
    const done = () => {
      clearTimeout(timeout)
      resolvePromise()
    }
    ws.addEventListener("error", done, { once: true })
    ws.addEventListener("close", done, { once: true })
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timeout)
        ws.close()
        reject(new Error("WebSocket unexpectedly opened"))
      },
      { once: true }
    )
  })
}

async function expectNoWsMessage(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolvePromise()
    }, 150)
    const onMessage = () => {
      cleanup()
      reject(new Error("Unexpected websocket message"))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener("message", onMessage)
    }
    ws.addEventListener("message", onMessage)
  })
}
