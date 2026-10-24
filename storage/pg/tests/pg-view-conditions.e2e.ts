import { expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { createTestStorage, disposeTestStorage } from "./helpers"

// Staff see every invoice but drafts, finance sees them all. The conditional scope's SQL is owned
// by the provider contract suite; this proves a role's condition reaches it through a reader, and
// that pages and totals stay exact on PostgreSQL.

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
  ],
})

const staff = defineGroup("staff")
const finance = defineGroup("finance")

const roles = [
  defineRole("staff", {
    grantedTo: [staff],
    grants: [can.view(Invoice).where((invoice) => invoice.p.status.neq("draft"))],
  }),
  defineRole("finance", { grantedTo: [finance], grants: [can.view(Invoice)] }),
]

const statuses = ["open", "draft", "paid", "draft", "open", "draft", "paid"]

// Reproduce: let core's resolveRoleGrants expand a grant that carries a condition, and staff
// list, page and count the drafts too.
test("PostgreSQL pages and counts only the objects a role's condition shows", async () => {
  const { storage } = await createTestStorage()
  const host = new SixbHost({
    id: "pg-view-conditions",
    ontology: [Invoice],
    groups: [staff, finance],
    roles,
    storage,
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
  })

  try {
    await host.closeBroker()

    for (const [index, status] of statuses.entries()) {
      await createTestSixb(host)
        .objects(Invoice)
        .upsert({ properties: { id: `inv-${index + 1}`, status } })
    }

    const readerIn = (groupIds: readonly string[]) =>
      createTestSixb(host, {
        authorization: resolveAuthorizationContext({
          principal: { type: "user", id: "usr_reader" },
          groupIds,
          roles: host.definitions.security.listResolvedRoles(),
        }),
      }).objects

    const pages = async (objects: ReturnType<typeof readerIn>) => {
      const listed: { ids: string[]; total: number | undefined; hasMore: boolean }[] = []

      for (let offset = 0; listed.at(-1)?.hasMore !== false; offset += 3) {
        const page = await objects.list({
          objectTypeIds: [Invoice.id],
          orderBy: "primaryId",
          order: "asc",
          limit: 3,
          offset,
        })
        listed.push({
          ids: page.objects.map((object) => object.primaryId),
          total: page.total,
          hasMore: page.hasMore,
        })
      }

      return listed
    }

    const count = async (objects: ReturnType<typeof readerIn>) =>
      (await objects.count({ query: { kind: "start", objectTypeId: Invoice.id } })).count

    const alice = readerIn([staff.id])
    expect(await pages(alice)).toEqual([
      { ids: ["inv-1", "inv-3", "inv-5"], total: 4, hasMore: true },
      { ids: ["inv-7"], total: 4, hasMore: false },
    ])
    expect(await count(alice)).toBe(4)

    const bob = readerIn([staff.id, finance.id])
    expect((await pages(bob)).map((page) => page.total)).toEqual([7, 7, 7])
    expect(await count(bob)).toBe(7)
  } finally {
    await disposeTestStorage(storage)
  }
})
