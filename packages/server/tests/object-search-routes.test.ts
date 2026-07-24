import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  prop,
  Sixb,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true },
    }),
  ],
  search: { title: "name", defaultText: ["name"] },
})

const invoiceViewers = defineGroup("invoice-viewers")
const invoiceViewer = defineRole("invoice.viewer", {
  grantedTo: [invoiceViewers],
  grants: [can.view(Invoice)],
})

function createApp() {
  const storage = new InMemoryStorage()
  const sixb = new Sixb<readonly OntologySource[]>({
    id: "object-search-tests",
    ontology: [Invoice],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [invoiceViewers],
    roles: [invoiceViewer],
    auth: { id: "test", kind: "dev" },
  })
  const app = createSixbApi(
    new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
  )
  return { app, sixb, storage }
}

async function seedSession(storage: InMemoryStorage, userId: string, groupIds: readonly string[]) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({
    id: userId,
    projectId: "object-search-tests",
    email: `${userId}@acme.com`,
  })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({
      projectId: "object-search-tests",
      userId,
      groupId,
      source: "manual",
    })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "object-search-tests",
    userId,
    strategyId: "test",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-06-27T10:00:00.000Z"),
    expiresAt: new Date("2099-06-27T10:00:00.000Z"),
  })
  return { cookie: `sixb_session=${credential.cookieValue}` }
}

describe("object search routes", () => {
  test("searches visible objects by text and primary id", async () => {
    const { app, sixb, storage } = createApp()
    const headers = await seedSession(storage, "usr_viewer", [invoiceViewers.id])
    await sixb.objects(Invoice).upsert({
      properties: { id: "inv-123", name: "July maintenance" },
    })

    const textSearch = await app.fetch(
      new Request("http://localhost/api/objects/search?q=maintenance", { headers })
    )
    expect(textSearch.status).toBe(200)
    expect(await textSearch.json()).toEqual({
      items: [
        {
          ref: { objectTypeId: "Invoice", primaryId: "inv-123" },
          label: "Invoice: July maintenance (inv-123)",
        },
      ],
    })

    const primaryIdSearch = await app.fetch(
      new Request("http://localhost/api/objects/search?q=inv-1", { headers })
    )
    expect(await primaryIdSearch.json()).toEqual({
      items: [
        {
          ref: { objectTypeId: "Invoice", primaryId: "inv-123" },
          label: "Invoice: July maintenance (inv-123)",
        },
      ],
    })
  })

  test("does not return objects the principal cannot view", async () => {
    const { app, sixb, storage } = createApp()
    const headers = await seedSession(storage, "usr_hidden", [])
    await sixb.objects(Invoice).upsert({
      properties: { id: "inv-123", name: "July maintenance" },
    })

    const response = await app.fetch(
      new Request("http://localhost/api/objects/search?q=inv-1", { headers })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [] })
  })
})
