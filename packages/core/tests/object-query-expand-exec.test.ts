import { beforeEach, describe, expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryObjectStorage,
  type JsonValue,
  link,
  type ObjectExpansion,
  type ObjectQuery,
  OntologyRegistry,
  prop,
} from "../src"
import type { StoredLinkMutationEvent, StoredObjectMutationEvent } from "../src/events"
import { countObjects, executeObjectQuery } from "../src/objects/query"
import type { ExpandedLinkValue, ExpandedObjectRow } from "../src/storage"
import { createStoredLinkMutationEvent, createStoredObjectMutationEvent } from "../src/testing"

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
    link("members", Contact, { cardinality: "many" }),
  ],
})

const ontology = new OntologyRegistry({
  sources: [Project, Opportunity, Company, Contact],
})

const PROJECT = "p1"

function objectEvent(
  objectTypeId: string,
  primaryId: string,
  properties: Record<string, JsonValue>
): StoredObjectMutationEvent {
  return createStoredObjectMutationEvent({
    projectId: PROJECT,
    occurredAt: "2026-01-01T00:00:00.000Z",
    cursor: crypto.randomUUID(),
    objectTypeId,
    primaryId,
    properties,
  })
}

function linkEvent(
  sourceTypeId: string,
  sourceId: string,
  linkId: string,
  targetTypeId: string,
  targetId: string,
  properties?: Record<string, JsonValue>
): StoredLinkMutationEvent {
  return createStoredLinkMutationEvent({
    projectId: PROJECT,
    occurredAt: "2026-01-01T00:00:00.000Z",
    cursor: crypto.randomUUID(),
    sourceTypeId,
    sourceId,
    linkId,
    targetTypeId,
    targetId,
    ...(properties === undefined ? {} : { properties }),
  })
}

// Records every (objectTypeId:primaryId) the executor batch-fetches, so dedup
// across parents can be asserted directly.
class BatchSpyStorage extends InMemoryObjectStorage {
  fetchedKeys: string[] = []

  override async getByPrimaryIdBatch(params: {
    projectId: string
    items: readonly { objectTypeId: string; primaryId: string }[]
  }) {
    for (const item of params.items) {
      this.fetchedKeys.push(`${item.objectTypeId}:${item.primaryId}`)
    }
    return super.getByPrimaryIdBatch(params)
  }
}

async function seed(storage: InMemoryObjectStorage): Promise<void> {
  await storage.applyObjectUpsert(
    objectEvent("Contact", "alice", { id: "alice", displayName: "Alice" })
  )
  await storage.applyObjectUpsert(objectEvent("Contact", "bob", { id: "bob", displayName: "Bob" }))
  await storage.applyObjectUpsert(
    objectEvent("Contact", "carol", { id: "carol", displayName: "Carol" })
  )

  await storage.applyObjectUpsert(objectEvent("Company", "acme", { id: "acme", name: "Acme" }))
  await storage.applyObjectUpsert(
    objectEvent("Company", "globex", { id: "globex", name: "Globex" })
  )
  // acme rolls up to globex — the third hop for the deep-expansion fixture.
  await storage.applyLinkUpsert(linkEvent("Company", "acme", "parent", "Company", "globex"))

  await storage.applyObjectUpsert(
    objectEvent("Opportunity", "opp-1", { id: "opp-1", title: "Deal A" })
  )
  await storage.applyObjectUpsert(
    objectEvent("Opportunity", "opp-2", { id: "opp-2", title: "Deal B" })
  )
  // Both opportunities point at the same company — the dedup fixture.
  await storage.applyLinkUpsert(linkEvent("Opportunity", "opp-1", "company", "Company", "acme"))
  await storage.applyLinkUpsert(linkEvent("Opportunity", "opp-2", "company", "Company", "acme"))
  await storage.applyLinkUpsert(linkEvent("Opportunity", "opp-1", "contact", "Contact", "alice"))

  await storage.applyObjectUpsert(
    objectEvent("Project", "proj-1", { id: "proj-1", name: "Proj One" })
  )
  await storage.applyObjectUpsert(
    objectEvent("Project", "proj-2", { id: "proj-2", name: "Proj Two" })
  )
  await storage.applyLinkUpsert(
    linkEvent("Project", "proj-1", "opportunity", "Opportunity", "opp-1")
  )
  await storage.applyLinkUpsert(
    linkEvent("Project", "proj-2", "opportunity", "Opportunity", "opp-2")
  )
  // proj-1 has three members, each edge carries a role.
  await storage.applyLinkUpsert(
    linkEvent("Project", "proj-1", "members", "Contact", "alice", { role: "lead" })
  )
  await storage.applyLinkUpsert(
    linkEvent("Project", "proj-1", "members", "Contact", "bob", { role: "dev" })
  )
  await storage.applyLinkUpsert(
    linkEvent("Project", "proj-1", "members", "Contact", "carol", { role: "qa" })
  )
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

let storage: BatchSpyStorage

beforeEach(async () => {
  storage = new BatchSpyStorage()
  await seed(storage)
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
    const acmeFetches = storage.fetchedKeys.filter((key) => key === "Company:acme")
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
    await storage.applyObjectUpsert(
      objectEvent("Project", "proj-3", { id: "proj-3", name: "Proj Three" })
    )
    // Points at an opportunity that was never upserted (dangling link).
    await storage.applyLinkUpsert(
      linkEvent("Project", "proj-3", "opportunity", "Opportunity", "ghost")
    )

    const result = await executeObjectQuery(
      {
        projectId: PROJECT,
        query: expandProjects([{ linkId: "opportunity", direction: "outgoing" }]),
      },
      { ontology, storage }
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
