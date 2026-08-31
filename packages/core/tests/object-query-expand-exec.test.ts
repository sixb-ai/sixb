import { beforeEach, describe, expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryStorage,
  link,
  type ObjectExpansion,
  type ObjectQuery,
  OntologyRegistry,
  prop,
} from "../src"
import { countObjects, executeObjectQuery } from "../src/objects/query"
import {
  type ExpandedLinkValue,
  type ExpandedObjectRow,
  linkBatchKey,
  type ObjectStorage,
} from "../src/storage"
import { createMaterializerTestFixture } from "../src/testing"

// Execution-side tests for `.expand()`: the planner routes expand through the
// bounded fallback, and the executor hydrates links over the batch storage
// primitives.

const sortable = { searchable: true, filterable: true, sortable: true } as const

const Contact = defineObjectType({
  id: "Contact",
  name: "Contact",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("displayName", "string", { required: true, query: sortable }),
  ],
})

const Company = defineObjectType({
  id: "Company",
  name: "Company",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true, query: sortable }),
  ],
  links: [link.self("parent", { cardinality: "one" })],
})

const Opportunity = defineObjectType({
  id: "Opportunity",
  name: "Opportunity",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string", { required: true }),
  ],
  links: [
    link("company", Company, { cardinality: "one" }),
    link("contact", Contact, { cardinality: "one" }),
  ],
})

const Project = defineObjectType({
  id: "Project",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true, query: sortable }),
  ],
  links: [
    link("opportunity", Opportunity, { cardinality: "one" }),
    link("members", Contact, {
      cardinality: "many",
      properties: [prop("role", "string")],
    }),
  ],
})

const ontology = new OntologyRegistry({
  sources: [Project, Opportunity, Company, Contact],
})

const PROJECT = "p1"

// Records every (objectTypeId:primaryId) the executor batch-fetches, so dedup
// across parents can be asserted directly.
function recordBatchFetches(storage: ObjectStorage): {
  readonly storage: ObjectStorage
  readonly fetchedKeys: string[]
} {
  const fetchedKeys: string[] = []
  const getByPrimaryIdBatch = storage.getByPrimaryIdBatch
  return {
    storage: new Proxy(storage, {
      get(target, property) {
        if (property === "getByPrimaryIdBatch") {
          return async (params: Parameters<ObjectStorage["getByPrimaryIdBatch"]>[0]) => {
            for (const item of params.items) {
              fetchedKeys.push(`${item.objectTypeId}:${item.primaryId}`)
            }
            return getByPrimaryIdBatch(params)
          }
        }
        return Reflect.get(target, property, target)
      },
    }),
    fetchedKeys,
  }
}

async function seed(fixture: ReturnType<typeof createMaterializerTestFixture>): Promise<void> {
  await fixture.seed({
    objects: [
      {
        ref: { objectTypeId: "Contact", primaryId: "alice" },
        properties: { id: "alice", displayName: "Alice" },
      },
      {
        ref: { objectTypeId: "Contact", primaryId: "bob" },
        properties: { id: "bob", displayName: "Bob" },
      },
      {
        ref: { objectTypeId: "Contact", primaryId: "carol" },
        properties: { id: "carol", displayName: "Carol" },
      },
      {
        ref: { objectTypeId: "Company", primaryId: "acme" },
        properties: { id: "acme", name: "Acme" },
      },
      {
        ref: { objectTypeId: "Company", primaryId: "globex" },
        properties: { id: "globex", name: "Globex" },
      },
      {
        ref: { objectTypeId: "Opportunity", primaryId: "opp-1" },
        properties: { id: "opp-1", title: "Deal A" },
      },
      {
        ref: { objectTypeId: "Opportunity", primaryId: "opp-2" },
        properties: { id: "opp-2", title: "Deal B" },
      },
      {
        ref: { objectTypeId: "Project", primaryId: "proj-1" },
        properties: { id: "proj-1", name: "Proj One" },
      },
      {
        ref: { objectTypeId: "Project", primaryId: "proj-2" },
        properties: { id: "proj-2", name: "Proj Two" },
      },
    ],
    links: [
      {
        ref: {
          source: { objectTypeId: "Company", primaryId: "acme" },
          linkId: "parent",
          target: { objectTypeId: "Company", primaryId: "globex" },
        },
      },
      {
        ref: {
          source: { objectTypeId: "Opportunity", primaryId: "opp-1" },
          linkId: "company",
          target: { objectTypeId: "Company", primaryId: "acme" },
        },
      },
      {
        ref: {
          source: { objectTypeId: "Opportunity", primaryId: "opp-2" },
          linkId: "company",
          target: { objectTypeId: "Company", primaryId: "acme" },
        },
      },
      {
        ref: {
          source: { objectTypeId: "Opportunity", primaryId: "opp-1" },
          linkId: "contact",
          target: { objectTypeId: "Contact", primaryId: "alice" },
        },
      },
      {
        ref: {
          source: { objectTypeId: "Project", primaryId: "proj-1" },
          linkId: "opportunity",
          target: { objectTypeId: "Opportunity", primaryId: "opp-1" },
        },
      },
      {
        ref: {
          source: { objectTypeId: "Project", primaryId: "proj-2" },
          linkId: "opportunity",
          target: { objectTypeId: "Opportunity", primaryId: "opp-2" },
        },
      },
      {
        ref: {
          source: { objectTypeId: "Project", primaryId: "proj-1" },
          linkId: "members",
          target: { objectTypeId: "Contact", primaryId: "alice" },
        },
        properties: { role: "lead" },
      },
      {
        ref: {
          source: { objectTypeId: "Project", primaryId: "proj-1" },
          linkId: "members",
          target: { objectTypeId: "Contact", primaryId: "bob" },
        },
        properties: { role: "dev" },
      },
      {
        ref: {
          source: { objectTypeId: "Project", primaryId: "proj-1" },
          linkId: "members",
          target: { objectTypeId: "Contact", primaryId: "carol" },
        },
        properties: { role: "qa" },
      },
    ],
  })
}

// Build `expand(limit(start))` directly: expand normalizes to the outer layer
// and the fallback needs an explicit bound on the parent scan.
function expandProjects(expansions: readonly ObjectExpansion[]): ObjectQuery {
  return {
    kind: "expand",
    expansions,
    input: { kind: "limit", limit: 100, input: { kind: "start", objectTypeId: "Project" } },
  }
}

function byId<T extends { primaryId: string }>(rows: readonly T[], id: string): T {
  const row = rows.find((candidate) => candidate.primaryId === id)
  if (!row) throw new Error(`row '${id}' not found`)
  return row
}

function single(value: ExpandedLinkValue | undefined): ExpandedObjectRow {
  if (value === null || value === undefined || Array.isArray(value)) {
    throw new Error("expected a single linked object")
  }
  // `Array.isArray` does not narrow a `readonly[]` away, so assert the scalar case.
  return value as ExpandedObjectRow
}

function list(value: ExpandedLinkValue | undefined): readonly ExpandedObjectRow[] {
  if (!Array.isArray(value)) throw new Error("expected a linked object array")
  return value
}

let storage: ObjectStorage
let fetchedKeys: string[]
let fixture: ReturnType<typeof createMaterializerTestFixture>

beforeEach(async () => {
  const provider = new InMemoryStorage()
  fixture = createMaterializerTestFixture({ projectId: PROJECT, ontology, storage: provider })
  const observed = recordBatchFetches(provider.objects)
  storage = observed.storage
  fetchedKeys = observed.fetchedKeys
  await seed(fixture)
})

describe("object query expand — execution", () => {
  test("plans as fallback and attaches a 'one' link as a single object", async () => {
    const result = await executeObjectQuery(
      {
        projectId: PROJECT,
        query: expandProjects([{ linkId: "opportunity", direction: "outgoing" }]),
      },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("fallback")
    const proj1 = byId(result.objects, "proj-1")
    const opportunity = single(proj1.links?.opportunity)
    expect(opportunity.objectTypeId).toBe("Opportunity")
    expect(opportunity.properties.title).toBe("Deal A")
  })

  test("attaches a 'many' link as an array carrying edge linkProperties", async () => {
    const result = await executeObjectQuery(
      { projectId: PROJECT, query: expandProjects([{ linkId: "members", direction: "outgoing" }]) },
      { ontology, storage }
    )

    const members = list(byId(result.objects, "proj-1").links?.members)
    expect(members).toHaveLength(3)
    const roles = members.map((member) => member.linkProperties?.role).sort()
    expect(roles).toEqual(["dev", "lead", "qa"])
  })

  test("hydrates a nested two-hop expansion", async () => {
    const result = await executeObjectQuery(
      {
        projectId: PROJECT,
        query: expandProjects([
          {
            linkId: "opportunity",
            direction: "outgoing",
            expand: [{ linkId: "company", direction: "outgoing" }],
          },
        ]),
      },
      { ontology, storage }
    )

    const opportunity = single(byId(result.objects, "proj-1").links?.opportunity)
    const company = single(opportunity.links?.company)
    expect(company.properties.name).toBe("Acme")
  })

  test("hydrates a three-hop expansion end to end", async () => {
    const result = await executeObjectQuery(
      {
        projectId: PROJECT,
        query: expandProjects([
          {
            linkId: "opportunity",
            direction: "outgoing",
            expand: [
              {
                linkId: "company",
                direction: "outgoing",
                expand: [{ linkId: "parent", direction: "outgoing" }],
              },
            ],
          },
        ]),
      },
      { ontology, storage }
    )

    // proj-1 → opp-1 → acme → globex, asserting identity + a property at each hop.
    const opportunity = single(byId(result.objects, "proj-1").links?.opportunity)
    expect(opportunity.properties.title).toBe("Deal A")
    const company = single(opportunity.links?.company)
    expect(company.primaryId).toBe("acme")
    const parent = single(company.links?.parent)
    expect(parent.primaryId).toBe("globex")
    expect(parent.properties.name).toBe("Globex")
  })

  test("fetches a target shared across parents exactly once", async () => {
    await executeObjectQuery(
      {
        projectId: PROJECT,
        query: expandProjects([
          {
            linkId: "opportunity",
            direction: "outgoing",
            expand: [{ linkId: "company", direction: "outgoing" }],
          },
        ]),
      },
      { ontology, storage }
    )

    // opp-1 and opp-2 both link to acme; the nested hop must batch it once.
    const acmeFetches = fetchedKeys.filter((key) => key === "Company:acme")
    expect(acmeFetches).toHaveLength(1)
  })

  test("applies orderBy + limit as a per-parent top-N trim", async () => {
    const result = await executeObjectQuery(
      {
        projectId: PROJECT,
        query: expandProjects([
          {
            linkId: "members",
            direction: "outgoing",
            limit: 2,
            orderBy: [{ kind: "property", propertyId: "displayName", direction: "desc" }],
          },
        ]),
      },
      { ontology, storage }
    )

    const members = list(byId(result.objects, "proj-1").links?.members)
    expect(members.map((member) => member.properties.displayName)).toEqual(["Carol", "Bob"])
  })

  test("enforces maxExpansionFanout as a backstop trim", async () => {
    const result = await executeObjectQuery(
      { projectId: PROJECT, query: expandProjects([{ linkId: "members", direction: "outgoing" }]) },
      { ontology, storage, maxExpansionFanout: 1 }
    )

    expect(list(byId(result.objects, "proj-1").links?.members)).toHaveLength(1)
  })

  test("hydrates an incoming expansion as an array of sources", async () => {
    const result = await executeObjectQuery(
      {
        projectId: PROJECT,
        query: {
          kind: "expand",
          expansions: [
            { linkId: "company", direction: "incoming", sourceObjectTypeId: "Opportunity" },
          ],
          input: { kind: "limit", limit: 100, input: { kind: "start", objectTypeId: "Company" } },
        },
      },
      { ontology, storage }
    )

    const opportunities = list(byId(result.objects, "acme").links?.company)
    expect(opportunities.map((opportunity) => opportunity.primaryId).sort()).toEqual([
      "opp-1",
      "opp-2",
    ])
  })

  test("hydrates a missing 'one' link target to null", async () => {
    await fixture.seed({
      objects: [
        {
          ref: { objectTypeId: "Project", primaryId: "proj-3" },
          properties: { id: "proj-3", name: "Proj Three" },
        },
      ],
    })
    const listLinksBatch = storage.listLinksBatch
    const storageWithConcurrentDeletion = new Proxy(storage, {
      get(target, property) {
        if (property !== "listLinksBatch") return Reflect.get(target, property, target)
        return async (params: Parameters<ObjectStorage["listLinksBatch"]>[0]) => {
          const result = await listLinksBatch(params)
          const withDeletedTarget = new Map(result)
          withDeletedTarget.set(linkBatchKey("Project", "proj-3", "opportunity"), [
            {
              projectId: PROJECT,
              sourceTypeId: "Project",
              sourceId: "proj-3",
              linkId: "opportunity",
              targetTypeId: "Opportunity",
              targetId: "ghost",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
              lastCommitId: "concurrent-delete",
            },
          ])
          return withDeletedTarget
        }
      },
    })

    const result = await executeObjectQuery(
      {
        projectId: PROJECT,
        query: expandProjects([{ linkId: "opportunity", direction: "outgoing" }]),
      },
      { ontology, storage: storageWithConcurrentDeletion }
    )

    expect(byId(result.objects, "proj-3").links?.opportunity).toBeNull()
  })

  test("count ignores expand (output-shaping)", async () => {
    const result = await countObjects(
      { projectId: PROJECT, query: expandProjects([{ linkId: "members", direction: "outgoing" }]) },
      { ontology, storage }
    )

    expect(result.count).toBe(2)
  })
})
