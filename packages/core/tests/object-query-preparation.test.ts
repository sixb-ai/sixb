import { expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryStorage,
  type ObjectQuery,
  OntologyRegistry,
  prepareObjectQueries,
  prop,
} from "../src"
import { executeObjectQuery } from "../src/objects/query"
import type { QueryObjectsInput } from "../src/storage"

const Item = defineObjectType({
  id: "Item",
  name: "Item",
  properties: [
    prop("key", "string", { required: true, primary: true }),
    prop("title", "string", { query: { searchable: true, sortable: true, text: true } }),
  ],
})
const ontology = new OntologyRegistry({ sources: [Item] })

// Guard removal: omit usePrimaryIdLookups in expandPushdownQuery; the captured provider
// query starts from the whole object type instead of bounded identities and this fails.
test("primary identity filters use bounded provider lookups while retaining the predicate", async () => {
  const storage = new InMemoryStorage()
  let received: QueryObjectsInput | undefined
  storage.objects.queryObjects = async (input) => {
    received = input
    return { objects: [], hasMore: false, total: 0 }
  }
  const query: ObjectQuery = {
    kind: "filter",
    input: { kind: "start", objectTypeId: "Item" },
    predicate: { op: "in", propertyId: "key", values: ["b", "a", "a"] },
  }
  await executeObjectQuery({ projectId: "p", query }, { ontology, storage: storage.objects })
  expect(received?.query).toMatchObject({
    kind: "filter",
    input: {
      kind: "refs",
      refs: [
        { objectTypeId: "Item", primaryId: "a" },
        { objectTypeId: "Item", primaryId: "b" },
      ],
    },
  })
  expect(received?.query.kind === "filter" && received.query.predicate).toMatchObject({
    op: "in",
    propertyId: "key",
  })
})

test("query index declarations validate against capabilities before preparation", () => {
  expect(
    () =>
      new OntologyRegistry({
        sources: [
          defineObjectType({
            ...Item,
            query: { indexes: [{ kind: "sort", fields: [{ propertyId: "missing" }] }] },
          }),
        ],
      })
  ).toThrow("unknown property")
  expect(
    () =>
      new OntologyRegistry({
        sources: [
          defineObjectType({ ...Item, query: { indexes: [{ kind: "text", propertyId: "key" }] } }),
        ],
      })
  ).toThrow("query.text")
})

test("query preparation reports unsupported providers explicitly", async () => {
  await expect(
    prepareObjectQueries({ projectId: "p", ontology, storage: new InMemoryStorage() })
  ).rejects.toThrow("does not support")
})
