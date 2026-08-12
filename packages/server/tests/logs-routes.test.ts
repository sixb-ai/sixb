import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  type AuthorizationContext,
  can,
  defineGroup,
  defineRole,
  emptyGrantIndex,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LogRunRef,
  noopLoggerProvider,
  type OntologySource,
  SixbHost,
  type SixbHostOptions,
} from "@sixb/core"
import type { BrokerRecord } from "@sixb/core/broker"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { Elysia } from "elysia"
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
    expect(
      parseLogSubscriptionMessage({
        type: "subscribe",
        run: { kind: "workflow", id: "   " },
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

      for (const runId of ["", "   "]) {
        const invalidRun = await fetch(
          `${baseUrl}/api/logs?kind=workflow&runId=${encodeURIComponent(runId)}`
        )
        expect(invalidRun.status).toBe(422)
      }
    })
  })

  test("requires observe:logs for history", async () => {
    const sixb = createTestSixb()
    const denied = logRoutesWithAuthz(sixb, authzWithoutLogs())
    expect((await denied.handle(new Request("http://localhost/api/logs"))).status).toBe(403)

    const allowed = logRoutesWithAuthz(sixb, authzWithLogs())
    expect((await allowed.handle(new Request("http://localhost/api/logs"))).status).toBe(200)
  })

  test("uses a bounded default page and rejects invalid limits", async () => {
    await withServer(async ({ baseUrl, sixb }) => {
      const session = sixb.logging.startExecution({ kind: "workflow", id: "bounded-history" })
      for (let index = 1; index <= 201; index += 1) {
        session.logger.info(`line ${index}`)
      }
      await session.flush()

      const defaultPage = await readLogs(baseUrl)
      expect(defaultPage.lines).toHaveLength(200)
      expect(defaultPage.hasMore).toBe(true)

      const explicitPage = await readLogs(baseUrl, { limit: "1000" })
      expect(explicitPage.lines).toHaveLength(201)
      expect(explicitPage.hasMore).toBe(false)

      for (const limit of ["0", "-1", "1.5", "10junk", "1001"]) {
        const response = await fetch(`${baseUrl}/api/logs?limit=${encodeURIComponent(limit)}`)
        expect(response.status).toBe(422)
      }
    })
  })
})

describe("/ws/logs", () => {
  test("uses the session handshake and requires observe:logs", async () => {
    await withAuthenticatedServer(async ({ baseUrl, allowedHeaders, deniedHeaders }) => {
      await expectWsRejected(new WebSocket(wsUrl(baseUrl)))

      const denied = webSocketWithHeaders(wsUrl(baseUrl), deniedHeaders)
      const deniedClose = await nextWsClose(denied)
      expect(deniedClose.code).toBe(1008)
      expect(deniedClose.reason).toContain("observe:logs")

      const allowed = webSocketWithHeaders(wsUrl(baseUrl), allowedHeaders)
      try {
        expect(await nextWsMessage(allowed)).toEqual({ type: "connected", channel: "logs" })
      } finally {
        allowed.close()
      }
    })
  })

  test("batches lines and filters server-side", async () => {
    await withServer(async ({ baseUrl, sixb }) => {
      const ws = new WebSocket(wsUrl(baseUrl))
      try {
        expect(await nextWsMessage(ws)).toEqual({ type: "connected", channel: "logs" })

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

        const first = new WebSocket(wsUrl(baseUrl))
        const firstConnected = nextWsMessage(first)
        const second = new WebSocket(wsUrl(baseUrl))
        const secondConnected = nextWsMessage(second)
        try {
          await Promise.all([firstConnected, secondConnected])
          const firstFrames = nextWsMessages(first, 2)
          first.send(
            JSON.stringify({
              type: "subscribe",
              run: { kind: "workflow", id: "w1" },
              afterCursor: cursor.cursor,
            })
          )
          const [subscribed, replay] = await firstFrames
          expect(subscribed).toMatchObject({ type: "subscribed" })
          expect(replay).toMatchObject({
            type: "logs",
            logs: [{ message: "after cursor" }],
          })

          // Install listeners before sending: Bun can deliver local websocket
          // frames before a listener added after send() observes them.
          const secondSubscribed = nextWsMessage(second)
          second.send(JSON.stringify({ type: "subscribe" }))
          expect(await secondSubscribed).toMatchObject({ type: "subscribed" })
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

async function seed(
  sixb: SixbHost<readonly OntologySource[]>,
  run: LogRunRef,
  message: string,
  level: "debug" | "info" | "warn" | "error"
): Promise<void> {
  const session = sixb.logging.startExecution(run)
  session.logger[level](message)
  await session.flush()
}

function createSixbInstance<TOntologySources extends readonly OntologySource[]>(
  options: SixbHostOptions<TOntologySources>
): SixbHost<TOntologySources> {
  return new SixbHost<TOntologySources>(options)
}

async function withServer(
  run: (context: {
    baseUrl: string
    sixb: SixbHost<readonly OntologySource[]>
    server: SixbServer
  }) => Promise<void>,
  options: { readonly broker?: InMemoryBroker } = {}
): Promise<void> {
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const sixb = createTestSixb(options.broker)
  const server = new SixbServer({
    host: sixb,
    hostname: "127.0.0.1",
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
  broker: InMemoryBroker = new InMemoryBroker(),
  options: {
    readonly storage?: InMemoryStorage
    readonly auth?: boolean
  } = {}
): SixbHost<readonly OntologySource[]> {
  const logsViewers = defineGroup("logs-viewers")
  const logsObserver = defineRole("logs.observer", {
    grantedTo: [logsViewers],
    grants: [can.observe("logs")],
  })
  return createSixbInstance<readonly OntologySource[]>({
    id: "logs-test-project",
    ontology: [],
    broker,
    storage: options.storage ?? new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    observability: { logs: { level: "debug" } },
    logger: noopLoggerProvider,
    ...(options.auth
      ? {
          groups: [logsViewers],
          roles: [logsObserver],
          auth: { id: "test", kind: "dev" as const },
        }
      : {}),
  })
}

async function withAuthenticatedServer(
  run: (context: {
    readonly baseUrl: string
    readonly allowedHeaders: Record<string, string>
    readonly deniedHeaders: Record<string, string>
  }) => Promise<void>
): Promise<void> {
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const storage = new InMemoryStorage()
  const sixb = createTestSixb(new InMemoryBroker(), { storage, auth: true })
  const allowedHeaders = await seedLogSession(storage, "allowed", ["logs-viewers"])
  const deniedHeaders = await seedLogSession(storage, "denied", [])
  const server = new SixbServer({
    host: sixb,
    hostname: "127.0.0.1",
    port,
    quiet: true,
    browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
  })

  await server.start()
  try {
    await run({ baseUrl, allowedHeaders, deniedHeaders })
  } finally {
    await server.stop()
  }
}

async function seedLogSession(
  storage: InMemoryStorage,
  userId: string,
  groupIds: readonly string[]
): Promise<Record<string, string>> {
  const credential = createSessionCredential(`ses_logs_${userId}`)
  await storage.auth.users.create({
    id: userId,
    projectId: "logs-test-project",
    email: `${userId}@example.test`,
  })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({
      projectId: "logs-test-project",
      userId,
      groupId,
      source: "manual",
    })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "logs-test-project",
    userId,
    strategyId: "test",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-07-11T00:00:00.000Z"),
    expiresAt: new Date("2099-07-11T00:00:00.000Z"),
  })
  return { cookie: `sixb_session=${credential.cookieValue}` }
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
    grants: emptyGrantIndex(),
  }
}

function authzWithLogs(): AuthorizationContext {
  const authz = authzWithoutLogs()
  return {
    ...authz,
    grants: { ...authz.grants, "observe:logs": new Set(["logs"]) },
  }
}

function logRoutesWithAuthz(
  sixb: SixbHost<readonly OntologySource[]>,
  authz: AuthorizationContext
) {
  const app = new Elysia()
  app.derive(({ request }) => ({
    sixb: bindRequestExecution(sixb, {
      request,
      authorization: { type: "principal", context: authz },
    }),
  }))
  return registerLogRoutes(app, sixb)
}

function wsUrl(baseUrl: string): string {
  return `${baseUrl.replace("http://", "ws://")}/ws/logs`
}

function webSocketWithHeaders(url: string, headers: Record<string, string>): WebSocket {
  return new WebSocket(url, { headers } as unknown as string[])
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

async function nextWsMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 3_000
): Promise<Record<string, unknown>[]> {
  return await new Promise((resolvePromise, reject) => {
    const messages: Record<string, unknown>[] = []
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${count} websocket messages`))
    }, timeoutMs)
    const onMessage = (event: MessageEvent) => {
      try {
        messages.push(JSON.parse(String(event.data)) as Record<string, unknown>)
        if (messages.length === count) {
          cleanup()
          resolvePromise(messages)
        }
      } catch (error) {
        cleanup()
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
      // A policy close may emit error before close; close carries the useful result.
    })
  })
}

async function expectWsRejected(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      ws.close()
      reject(new Error("Timed out waiting for websocket rejection"))
    }, 3_000)
    const done = () => {
      cleanup()
      resolvePromise()
    }
    const opened = () => {
      cleanup()
      ws.close()
      reject(new Error("WebSocket unexpectedly opened"))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener("error", done)
      ws.removeEventListener("close", done)
      ws.removeEventListener("open", opened)
    }
    ws.addEventListener("error", done, { once: true })
    ws.addEventListener("close", done, { once: true })
    ws.addEventListener("open", opened, { once: true })
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
