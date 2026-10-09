import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  can,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "object-markings-tests"
const financial = defineMarking("financial")

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { query: { searchable: true, text: true } }),
    prop("amount", "double", {
      query: { searchable: true, filterable: true },
      markings: [financial],
    }),
  ],
  search: { title: "title", defaultText: ["title"] },
})

// Every default text field is marked, so an uncleared caller cannot search this type.
const Payslip = defineObjectType({
  id: "Payslip",
  name: "Payslip",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("summary", "string", { query: { searchable: true, text: true }, markings: [financial] }),
  ],
  search: { title: "summary", defaultText: ["summary"] },
})

const staff = defineGroup("staff")
const finance = defineGroup("finance")
const reader = defineRole("reader", {
  grantedTo: [staff, finance],
  grants: [can.view([Invoice, Payslip])],
})
const financeClearance = defineRole("finance-clearance", {
  grantedTo: [finance],
  clearances: [financial],
})

async function createHost() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [Invoice, Payslip],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    markings: [financial],
    groups: [staff, finance],
    roles: [reader, financeClearance],
    auth: { id: "test", kind: "dev" },
  })
  const trusted = createTestSixb(host)
  await trusted.objects(Invoice).upsert({ properties: { id: "inv-1", title: "July", amount: 120 } })
  await trusted.objects(Payslip).upsert({ properties: { id: "pay-1", summary: "July" } })
  return { host, storage, trusted }
}

async function createApp() {
  const { host, storage } = await createHost()
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  return { app, storage }
}

async function seedSession(storage: InMemoryStorage, userId: string, groupIds: readonly string[]) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({ id: userId, projectId, email: `${userId}@acme.com` })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({ projectId, userId, groupId, source: "manual" })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId,
    strategyId: "test",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-10-08T10:00:00.000Z"),
    expiresAt: new Date("2099-10-08T10:00:00.000Z"),
  })
  return { cookie: `sixb_session=${credential.cookieValue}` }
}

describe("object routes with markings", () => {
  test("responses omit marked properties and list them in redactions", async () => {
    const { app, storage } = await createApp()
    const staffHeaders = await seedSession(storage, "usr_staff", [staff.id])
    const financeHeaders = await seedSession(storage, "usr_finance", [finance.id])

    const redacted = await app.fetch(
      new Request("http://localhost/api/objects/Invoice/inv-1", { headers: staffHeaders })
    )
    expect(redacted.status).toBe(200)
    expect(await redacted.json()).toMatchObject({
      properties: { id: "inv-1", title: "July" },
      redactions: { amount: { reason: "missing_clearance" } },
    })

    const cleared = await app.fetch(
      new Request("http://localhost/api/objects/Invoice/inv-1", { headers: financeHeaders })
    )
    const body = await cleared.json()
    expect(body.properties).toEqual({ id: "inv-1", title: "July", amount: 120 })
    expect(body.redactions).toBeUndefined()
  })

  test("filtering by a marked property answers 403", async () => {
    const { app, storage } = await createApp()
    const headers = await seedSession(storage, "usr_staff", [staff.id])

    const response = await app.fetch(
      new Request("http://localhost/api/objects/query", {
        method: "POST",
        headers: {
          cookie: `${headers.cookie}; sixb_csrf=csrf_1`,
          "x-sixb-csrf": "csrf_1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: {
            kind: "filter",
            input: { kind: "start", objectTypeId: "Invoice" },
            predicate: { op: "gt", propertyId: "amount", value: 100 },
          },
        }),
      })
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error:
        "[Sixb] Cannot filter by 'Invoice.amount' at '$.predicate': it requires clearance for marking 'financial'.",
    })
  })

  test("global search skips types the caller cannot search and redacted titles", async () => {
    const { app, storage } = await createApp()
    const staffHeaders = await seedSession(storage, "usr_staff", [staff.id])
    const financeHeaders = await seedSession(storage, "usr_finance", [finance.id])

    const staffSearch = await app.fetch(
      new Request("http://localhost/api/objects/search?q=July", { headers: staffHeaders })
    )
    expect(staffSearch.status).toBe(200)
    expect(await staffSearch.json()).toEqual({
      items: [
        { ref: { objectTypeId: "Invoice", primaryId: "inv-1" }, label: "Invoice: July (inv-1)" },
      ],
    })

    const financeSearch = await app.fetch(
      new Request("http://localhost/api/objects/search?q=July", { headers: financeHeaders })
    )
    expect((await financeSearch.json()).items).toContainEqual({
      ref: { objectTypeId: "Payslip", primaryId: "pay-1" },
      label: "Payslip: July (pay-1)",
    })

    // A primary id match on a type with a marked title falls back to the id.
    const byId = await app.fetch(
      new Request("http://localhost/api/objects/search?q=pay-", { headers: staffHeaders })
    )
    expect(await byId.json()).toEqual({
      items: [{ ref: { objectTypeId: "Payslip", primaryId: "pay-1" }, label: "Payslip pay-1" }],
    })
  })
})

describe("event stream with markings", () => {
  // To see this fail, drop `view` from the subscription in `src/routes/ws/events.ts`: both events
  // then arrive with `amount`.
  test("replayed and live object events omit marked properties", async () => {
    const { host, storage, trusted } = await createHost()
    const headers = await seedSession(storage, "usr_staff", [staff.id])
    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const server = new SixbServer({
      host,
      hostname: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
    })

    await server.start()
    // Bun's WebSocket accepts an options object with `headers`; the DOM lib types only model the
    // subprotocols argument, so widen at the call site.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, {
      headers,
    } as unknown as string[])
    const messages = wsMessages(ws)
    try {
      expect(await messages.next()).toEqual({ type: "connected", channel: "events" })

      // Written before the subscription, so it is replayed; the next one is delivered live.
      await trusted
        .objects(Invoice)
        .upsert({ properties: { id: "inv-2", title: "August", amount: 300 } })
      ws.send(JSON.stringify({ type: "subscribe", topic: "objects", objectTypeId: "Invoice" }))
      expect(await messages.next()).toMatchObject({ type: "subscribed" })
      const replayed = await messages.next()

      await trusted
        .objects(Invoice)
        .upsert({ properties: { id: "inv-3", title: "September", amount: 450 } })
      const live = await messages.next()

      for (const [message, properties] of [
        [replayed, { id: "inv-2", title: "August" }],
        [live, { id: "inv-3", title: "September" }],
      ] as const) {
        expect(message).toMatchObject({
          type: "event",
          event: { type: "object.created", payload: { properties } },
        })
        const { payload } = (message as { event: { payload: Record<string, unknown> } }).event
        expect(payload.properties).toEqual(properties)
        expect(payload.propertyChanges).not.toHaveProperty("amount")
        expect(payload.redactions).toEqual({ amount: { reason: "missing_clearance" } })
      }
    } finally {
      ws.close()
      await server.stop()
    }
  })
})

/** Buffers socket messages so none is lost between two awaits. */
function wsMessages(ws: WebSocket) {
  const received: unknown[] = []
  let wake: (() => void) | undefined
  ws.addEventListener("message", (event) => {
    received.push(JSON.parse(String((event as MessageEvent).data)))
    wake?.()
  })

  return {
    async next(): Promise<unknown> {
      const deadline = Date.now() + 3_000
      while (received.length === 0) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error("Timed out waiting for websocket message")
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, remaining)
          wake = () => {
            clearTimeout(timeout)
            resolve()
          }
        })
      }
      return received.shift()
    },
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

      const { port } = address
      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(port)
      })
    })
  })
}
