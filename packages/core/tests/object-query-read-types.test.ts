import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryStorage,
  link,
  type ObjectQuery,
  OntologyRegistry,
  prop,
} from "../src"
import { countObjects, executeObjectQuery, existsObjects, facetObjects } from "../src/objects/query"

const primary = prop("id", "string", { required: true, primary: true })
const Organization = defineObjectType({
  id: "Organization",
  name: "Organization",
  properties: [primary],
})
const Quote = defineObjectType({
  id: "Quote",
  name: "Quote",
  properties: [
    primary,
    prop("status", "string", { query: { searchable: true, filterable: true, facet: true } }),
  ],
  links: [link("organization", Organization, { cardinality: "one" })],
})
const ontology = new OntologyRegistry({ sources: [Quote, Organization] })
const options = { ontology, storage: new InMemoryStorage().objects }
const projectId = "reads"

const expanded: ObjectQuery = {
  kind: "expand",
  input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Quote" } },
  expansions: [{ linkId: "organization", direction: "outgoing" }],
}
const plain: ObjectQuery = { kind: "start", objectTypeId: "Quote" }

describe("the types a query reads", () => {
  test("a list names the types it expands", async () => {
    const { plan } = await executeObjectQuery({ projectId, query: expanded }, options)

    expect([...(plan.readObjectTypeIds ?? [])].sort()).toEqual(["Organization", "Quote"])
  })

  test("counts, exists checks and facets name theirs", async () => {
    const count = await countObjects({ projectId, query: plain }, options)
    const exists = await existsObjects({ projectId, query: plain }, options)
    const facets = await facetObjects(
      { projectId, query: plain, facets: [{ propertyId: "status", limit: 5 }] },
      options
    )

    expect(count.plan.readObjectTypeIds).toEqual(["Quote"])
    expect(exists.plan.readObjectTypeIds).toEqual(["Quote"])
    expect(facets.plan.readObjectTypeIds).toEqual(["Quote"])
  })
})
