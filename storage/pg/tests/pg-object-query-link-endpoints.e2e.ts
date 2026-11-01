import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { defineObjectType, link, type ObjectQuery, OntologyRegistry, prop } from "@sixb/core"
import { executeObjectQuery } from "@sixb/core/internal/query"
import type { PostgresStorage } from "../src"
import { createPgClient, type SQL } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

const PROJECT = "endpoints"
const sortable = { searchable: true, filterable: true, sortable: true } as const
const primary = prop("id", "string", { required: true, primary: true })

const Party = defineObjectType({
  id: "Party",
  name: "Party",
  properties: [primary, prop("name", "string", { query: sortable })],
})
const Vendor = defineObjectType({
  id: "Vendor",
  name: "Vendor",
  extends: Party,
  properties: [prop("taxId", "string")],
})
const Site = defineObjectType({
  id: "Site",
  name: "Site",
  properties: [primary, prop("name", "string", { query: sortable })],
})
const Quote = defineObjectType({
  id: "Quote",
  name: "Quote",
  properties: [primary],
  links: [
    link("party", Party, { cardinality: "one" }),
    link("place", [Party, Site], { cardinality: "one" }),
    link.any("anything"),
  ],
})

const ontology = new OntologyRegistry({ sources: [Party, Vendor, Site, Quote] })
let storage: PostgresStorage
let sql: SQL

beforeAll(async () => {
  const created = await createTestStorage()
  storage = created.storage
  sql = createPgClient({
    connectionString: created.connectionString,
    schemaName: created.schemaName,
    max: 1,
  })
  const objects: [string, string][] = [
    ["Party", "party-1"],
    ["Vendor", "vendor-1"],
    ["Site", "site-1"],
    ["Quote", "quote-1"],
    ["Quote", "quote-2"],
    ["Quote", "quote-3"],
  ]
  for (const [type, id] of objects) {
    await sql`INSERT INTO objects
      VALUES (${PROJECT}, ${type}, ${id}, ${sql.json({ id, name: id })}, now(), now(), 1, 'seed')`
  }
  const links: [string, string, string, string][] = [
    ["quote-1", "party", "Party", "party-1"],
    // Links accept subtype targets: the link declares Party, the row is a Vendor.
    ["quote-2", "party", "Vendor", "vendor-1"],
    ["quote-1", "place", "Site", "site-1"],
    ["quote-2", "place", "Party", "party-1"],
    ["quote-3", "anything", "Site", "site-1"],
  ]
  for (const [source, linkId, targetType, target] of links) {
    await sql`INSERT INTO links
      VALUES (${PROJECT}, 'Quote', ${source}, ${linkId}, ${targetType}, ${target}, NULL, now(), now(), 'seed')`
  }
})

afterAll(async () => {
  await sql?.end()
  if (storage) await disposeTestStorage(storage)
})

async function run(query: ObjectQuery) {
  const captured: ObjectQuery[] = []
  const objects = storage.objects
  const recording = new Proxy(objects, {
    get(target, property, receiver) {
      if (property !== "queryObjects") return Reflect.get(target, property, receiver)
      return async (input: Parameters<NonNullable<typeof objects.queryObjects>>[0]) => {
        captured.push(input.query)
        return objects.queryObjects!(input)
      }
    },
  })
  const result = await executeObjectQuery(
    { projectId: PROJECT, query, includeTotal: false },
    { ontology, storage: recording }
  )
  return {
    ids: result.objects.map((object) => object.primaryId).sort(),
    planned: captured[0],
    objects: result.objects,
  }
}

const quotes: ObjectQuery = { kind: "start", objectTypeId: "Quote" }
const follow = (linkId: string): ObjectQuery => ({
  kind: "limit",
  limit: 10,
  input: { kind: "traverse", input: quotes, linkId, direction: "outgoing" },
})

describe("link endpoint types", () => {
  test("an outgoing traversal names its targets and reaches their subtypes", async () => {
    const { ids, planned } = await run(follow("party"))

    expect(ids).toEqual(["party-1", "vendor-1"])
    expect(JSON.stringify(planned)).toContain('"endpointObjectTypeIds":["Party","Vendor"]')
  })

  test("a polymorphic link names every target", async () => {
    const { ids, planned } = await run(follow("place"))

    expect(ids).toEqual(["party-1", "site-1"])
    expect(JSON.stringify(planned)).toContain('"endpointObjectTypeIds":["Party","Vendor","Site"]')
  })

  test("an incoming traversal without a source names every type declaring the link", async () => {
    const { ids } = await run({
      kind: "traverse",
      input: { kind: "refs", refs: [{ objectTypeId: "Party", primaryId: "party-1" }] },
      linkId: "party",
      direction: "incoming",
    })

    expect(ids).toEqual(["quote-1"])
  })

  test("an incoming traversal over a wildcard link finds its sources", async () => {
    const { ids } = await run({
      kind: "traverse",
      input: { kind: "refs", refs: [{ objectTypeId: "Site", primaryId: "site-1" }] },
      linkId: "anything",
      direction: "incoming",
    })

    expect(ids).toEqual(["quote-3"])
  })

  test("a value in the query itself is replaced, so it cannot hide stored rows", async () => {
    const { ids } = await run({
      kind: "limit",
      limit: 10,
      input: {
        kind: "traverse",
        input: quotes,
        linkId: "party",
        direction: "outgoing",
        endpointObjectTypeIds: ["Site"],
      },
    })

    expect(ids).toEqual(["party-1", "vendor-1"])
  })

  test("an expansion hydrates subtype targets", async () => {
    const { objects, planned } = await run({
      kind: "expand",
      input: { kind: "limit", limit: 10, input: quotes },
      expansions: [{ linkId: "party", direction: "outgoing" }],
    })

    const hydrated = objects.map((object) => {
      const party = object.links?.party
      return party && "primaryId" in party ? party.primaryId : null
    })
    expect(hydrated.sort()).toEqual(["party-1", "vendor-1", null].sort())
    expect(JSON.stringify(planned)).toContain('"endpointObjectTypeIds":["Party","Vendor"]')
  })
})
