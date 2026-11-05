import { expect, test } from "bun:test"
import {
  currentUser,
  defineObjectType,
  InMemoryStorage,
  type ObjectQuery,
  OntologyRegistry,
  prepareObjectQueries,
  prop,
  ref,
  type ViewCondition,
} from "../src"
import { executeObjectQuery } from "../src/objects/query"
import type {
  ObjectQueryPreparationPlan,
  ObjectVisibilityKeys,
  QueryObjectsInput,
} from "../src/storage"

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

test("preparation hands storage each type's condition keys, and warns about conditions without", async () => {
  const Ticket = defineObjectType({
    id: "Ticket",
    name: "Ticket",
    properties: [
      prop("key", "string", { required: true, primary: true }),
      prop("owner", ref.user(), { nullable: true, query: { searchable: true, filterable: true } }),
    ],
  })
  const Incident = defineObjectType({
    id: "Incident",
    name: "Incident",
    extends: Ticket,
    properties: [],
  })
  const tickets = new OntologyRegistry({ sources: [Item, Ticket, Incident] })

  const condition = (roleId: string, op: "eq" | "neq"): ViewCondition => ({
    roleId,
    objectTypeId: Ticket.id,
    predicate: { op, propertyId: "owner", value: currentUser(), scalarKind: "userRef" },
  })
  const plans: ObjectQueryPreparationPlan[] = []
  const storage = Object.assign(new InMemoryStorage(), {
    prepareObjectQueries: async (plan: ObjectQueryPreparationPlan) => {
      plans.push(plan)
      return { status: "prepared" as const, objectTypes: 3, indexes: 0, warnings: [] }
    },
  })

  const result = await prepareObjectQueries({
    projectId: "p",
    ontology: tickets,
    security: { listViewConditions: () => [condition("mine", "eq"), condition("others", "neq")] },
    storage,
  })

  const owner: ObjectVisibilityKeys[] = [{ kind: "user", propertyId: "owner" }]
  expect(plans[0]?.objectTypes.map((type) => [type.objectTypeId, type.visibility])).toEqual([
    ["Item", []],
    ["Ticket", owner],
    ["Incident", owner],
  ])
  expect(result.warnings).toEqual([
    "Role 'others': can.view(Ticket).where(...) negates currentUser() or needs it twice at once, so members' reads check every object.",
  ])

  // Without the conditions, storage is told nothing about them.
  await prepareObjectQueries({ projectId: "p", ontology: tickets, storage })
  expect(plans[1]?.objectTypes.some((type) => "visibility" in type)).toBe(false)
})
