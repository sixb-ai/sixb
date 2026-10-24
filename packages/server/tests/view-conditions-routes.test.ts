import { describe, expect, test } from "bun:test"
import {
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  link,
  prop,
  SixbHost,
  SYSTEM_PRINCIPAL,
} from "@sixb/core"
import { createAccessTokenCredential } from "@sixb/core/internal/auth"
import { createTestSixb } from "@sixb/core/testing"
import { waitFor } from "../../core/tests/test-runtime-deps"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// The issue's invoices, end to end over HTTP: staff see every invoice but drafts, finance sees
// them all. Alice is staff, Bob is staff and finance, and the reports service account is staff.
// What each surface does with a hidden object is owned by core's view-condition-*.test.ts; this
// proves that the roles a session resolves reach every route.

const projectId = "view-conditions-routes"
const NOW = new Date("2026-10-24T10:00:00.000Z")

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
  ],
})

const Customer = defineObjectType({
  id: "customer",
  name: "Customer",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("invoices", Invoice, { cardinality: "many" })],
})

const sendInvoice = defineAction("send-invoice")
  .on(Invoice)
  .params({})
  .edits(() => {})

const staff = defineGroup("staff")
const finance = defineGroup("finance")

const staffRole = defineRole("staff", {
  grantedTo: [staff],
  grants: [
    can.view(Invoice).where((invoice) => invoice.p.status.neq("draft")),
    can.view(Customer),
    can.edit(Invoice),
    can.apply(sendInvoice),
  ],
})

const financeRole = defineRole("finance", { grantedTo: [finance], grants: [can.view(Invoice)] })

const invoices = [
  { id: "inv-1", status: "open" },
  { id: "inv-2", status: "draft" },
  { id: "inv-3", status: "paid" },
  { id: "inv-4", status: "draft" },
  { id: "inv-5", status: "open" },
] as const

const visible = ["inv-1", "inv-3", "inv-5"]
const every = ["inv-1", "inv-2", "inv-3", "inv-4", "inv-5"]

async function createApp() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [Invoice, Customer],
    actions: [sendInvoice],
    groups: [staff, finance],
    roles: [staffRole, financeRole],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: { id: "test", kind: "dev" },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )

  const trusted = createTestSixb(host)
  await trusted.objects(Customer).upsert({ properties: { id: "cust-1" } })

  for (const properties of invoices) {
    await trusted.objects(Invoice).upsert({ properties })
    await trusted.objects.upsertLink(Customer.id, "cust-1", "invoices", {
      targetTypeId: Invoice.id,
      targetId: properties.id,
    })
  }

  const callers = {
    alice: await seedUser(storage, "usr_alice", [staff.id]),
    bob: await seedUser(storage, "usr_bob", [staff.id, finance.id]),
    reports: await seedServiceAccount(storage, "svc_reports", [staff.id]),
  }

  const call = (caller: keyof typeof callers, path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${callers[caller]}`,
          "content-type": "application/json",
        },
      })
    )

  return { host, trusted, call }
}

type Call = Awaited<ReturnType<typeof createApp>>["call"]
type Caller = Parameters<Call>[0]

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })

/** Every invoice a caller lists, two per page, with the total each page reports. */
async function listInvoices(call: Call, caller: Caller) {
  const ids: string[] = []
  const totals = new Set<number>()

  for (let offset = 0; ; offset += 2) {
    const response = await call(
      caller,
      `/api/objects?objectTypeId=invoice&orderBy=primaryId&order=asc&limit=2&offset=${offset}`
    )
    expect(response.status).toBe(200)

    const page = (await response.json()) as {
      objects: { primaryId: string }[]
      hasMore: boolean
      total: number
    }
    ids.push(...page.objects.map((object) => object.primaryId))
    totals.add(page.total)
    if (!page.hasMore) return { ids, totals: [...totals] }
  }
}

async function countInvoices(call: Call, caller: Caller): Promise<number> {
  const response = await call(
    caller,
    "/api/objects/query/count",
    post({ query: { kind: "start", objectTypeId: Invoice.id } })
  )
  return ((await response.json()) as { count: number }).count
}

// Reproduce: let core's resolveRoleGrants expand a grant that carries a condition, and every
// caller reads every invoice; let resolveAuthorizationContext keep conditions on a type a role
// views whole, and Bob reads only what Alice does.
describe("conditional view grants over HTTP", () => {
  test("lists, pages, counts and gets only the invoices a caller's roles show", async () => {
    const { call } = await createApp()

    for (const caller of ["alice", "reports"] as const) {
      expect(await listInvoices(call, caller)).toEqual({ ids: visible, totals: [3] })
      expect(await countInvoices(call, caller)).toBe(3)
    }

    expect(await listInvoices(call, "bob")).toEqual({ ids: every, totals: [5] })
    expect(await countInvoices(call, "bob")).toBe(5)

    // A hidden invoice answers exactly as a missing one.
    const hidden = await call("alice", "/api/objects/invoice/inv-2")
    const missing = await call("alice", "/api/objects/invoice/inv-404")
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual(await missing.json())

    expect((await call("bob", "/api/objects/invoice/inv-2")).status).toBe(200)
  })

  test("a link expansion reaches only the invoices a caller's roles show", async () => {
    const { call } = await createApp()

    const expanded = async (caller: Caller) => {
      const response = await call(
        caller,
        "/api/objects/query",
        post({
          query: {
            kind: "expand",
            input: { kind: "limit", limit: 1, input: { kind: "start", objectTypeId: Customer.id } },
            expansions: [{ linkId: "invoices", direction: "outgoing" }],
          },
        })
      )
      const body = (await response.json()) as {
        objects: { links: { invoices: { primaryId: string }[] } }[]
      }
      return body.objects[0]?.links.invoices.map((invoice) => invoice.primaryId).sort()
    }

    expect(await expanded("alice")).toEqual(visible)
    expect(await expanded("bob")).toEqual(every)
  })

  test("an update that hides an invoice reaches no caller it hides it from", async () => {
    const { host, trusted, call } = await createApp()

    await trusted.objects(Invoice).upsert({ properties: { id: "inv-1", status: "draft" } })
    await waitFor(
      () => host.events.read({ topics: ["objects"] }),
      (events) => events.some((event) => event.type === "object.updated")
    )

    const shown = async (caller: Caller) => {
      const response = await call(caller, "/api/events?topic=objects")
      const body = (await response.json()) as {
        events: { type: string; payload: { objectTypeId: string; primaryId: string } }[]
      }
      return body.events
        .filter((event) => event.payload.objectTypeId === Invoice.id)
        .map((event) => `${event.type} ${event.payload.primaryId}`)
        .sort()
    }

    // Alice saw inv-1 created, and is never told it changed.
    expect(await shown("alice")).toEqual([
      "object.created inv-1",
      "object.created inv-3",
      "object.created inv-5",
    ])
    expect(await shown("bob")).toEqual([
      ...every.map((id) => `object.created ${id}`),
      "object.updated inv-1",
    ])
  })

  test("an action or a write on a hidden invoice finds nothing to act on", async () => {
    const { trusted, call } = await createApp()

    const send = (caller: Caller, primaryId: string) =>
      call(
        caller,
        "/api/actions/send-invoice",
        post({ subject: { kind: "object", objectTypeId: Invoice.id, primaryId } })
      )

    expect((await send("alice", "inv-1")).status).toBe(200)
    expect((await send("alice", "inv-2")).status).toBe(404)
    expect((await send("alice", "inv-404")).status).toBe(404)
    expect((await send("bob", "inv-2")).status).toBe(200)

    const put = (caller: Caller, primaryId: string) =>
      call(caller, `/api/objects/invoice/${primaryId}`, {
        method: "PUT",
        body: JSON.stringify({ properties: { status: "open" } }),
      })

    expect((await put("alice", "inv-3")).status).toBe(200)

    // A create on the id of an invoice Alice cannot see tells her the id is taken, and nothing
    // else; the invoice stays as it was.
    const taken = await put("alice", "inv-2")
    expect(taken.status).toBe(409)
    expect(await taken.json()).toMatchObject({ code: "object.unique_violation" })
    expect(await trusted.objects(Invoice).get("inv-2")).toMatchObject({
      properties: { status: "draft" },
    })
  })
})

async function seedUser(
  storage: InMemoryStorage,
  userId: string,
  groupIds: readonly string[]
): Promise<string> {
  await storage.auth.users.create({ id: userId, projectId, email: `${userId}@acme.com` })

  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({ projectId, userId, groupId, source: "manual" })
  }

  return seedToken(storage, { type: "user", id: userId })
}

async function seedServiceAccount(
  storage: InMemoryStorage,
  serviceAccountId: string,
  groupIds: readonly string[]
): Promise<string> {
  await storage.auth.serviceAccounts.create({
    id: serviceAccountId,
    projectId,
    name: "Reports",
    status: "active",
    createdByPrincipal: SYSTEM_PRINCIPAL,
    createdAt: NOW,
    updatedAt: NOW,
  })

  for (const groupId of groupIds) {
    await storage.auth.serviceAccountGroupMemberships.upsert({
      projectId,
      serviceAccountId,
      groupId,
      source: "manual",
    })
  }

  return seedToken(storage, { type: "serviceAccount", id: serviceAccountId })
}

async function seedToken(
  storage: InMemoryStorage,
  subject: { readonly type: "user" | "serviceAccount"; readonly id: string }
): Promise<string> {
  const kind = subject.type === "user" ? "personal" : "serviceAccount"
  const credential = createAccessTokenCredential(kind)

  await storage.auth.accessTokens.create({
    id: credential.tokenId,
    projectId,
    name: `${subject.id} token`,
    kind,
    subject,
    tokenHash: credential.tokenHash,
    createdAt: NOW,
    expiresAt: new Date("2099-10-24T10:00:00.000Z"),
  })

  return credential.tokenValue
}
