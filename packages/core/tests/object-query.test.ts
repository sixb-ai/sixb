import { describe, expect, test } from "bun:test"
import {
  decimal,
  defineObjectType,
  InMemoryObjectStorage,
  link,
  type ObjectQuery,
  ObjectQueryExecutionError,
  ObjectQueryPlanningError,
  ObjectQueryValidationError,
  OntologyRegistry,
  prop,
  stringEnum,
} from "../src"
import type { StoredLinkMutationEvent, StoredObjectMutationEvent } from "../src/events"
import {
  collectObjectQueryValidationIssues,
  countObjects,
  executeObjectQuery,
  existsObjects,
  explainObjectQuery,
  facetObjects,
  formatObjectQueryExplanation,
  normalizeObjectQuery,
  planObjectQuery,
  validateObjectQuery,
} from "../src/objects/query"
import type {
  CountObjectsInput,
  CountObjectsResult,
  ExistsObjectsInput,
  ExistsObjectsResult,
  FacetObjectsInput,
  FacetObjectsResult,
  ObjectQueryCapabilities,
  ObjectStorage,
  QueryObjectsInput,
  QueryObjectsResult,
} from "../src/storage"

const Order = defineObjectType({
  id: "Order",
  name: "Order",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("createdAt", "timestamp", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("total", "double", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
  ],
})

const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("email", "string", {
      query: { searchable: true, text: true, exact: true },
    }),
    prop("status", stringEnum(["active", "paused"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop(
      "embedding",
      { type: "array", items: "double" },
      {
        query: { searchable: true, vector: true },
      }
    ),
  ],
  links: [link("orders", Order)],
  search: {
    title: "name",
    defaultText: ["name", "email"],
    exact: ["id", "email"],
    vector: { property: "embedding", source: ["name", "email"] },
  },
})

const WildcardSource = defineObjectType({
  id: "WildcardSource",
  name: "Wildcard Source",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link.any("anything")],
})

const SearchProfileCustomer = defineObjectType({
  id: "SearchProfileCustomer",
  name: "Search Profile Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      query: { searchable: true, text: true, filterable: true, exact: true },
    }),
    prop("notes", "string", {
      query: { searchable: true, text: true },
    }),
    prop(
      "embedding",
      { type: "array", items: "double" },
      { query: { searchable: true, vector: true } }
    ),
    prop(
      "altEmbedding",
      { type: "array", items: "double" },
      { query: { searchable: true, vector: true } }
    ),
  ],
  search: {
    defaultText: ["name", "notes"],
    vector: { property: "embedding", source: ["name"] },
  },
})

const TextNoDefault = defineObjectType({
  id: "TextNoDefault",
  name: "Text No Default",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { query: { searchable: true, text: true } }),
  ],
})

const Balance = defineObjectType({
  id: "Balance",
  name: "Balance",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("amount", "decimal", {
      required: true,
      query: { searchable: true, filterable: true, sortable: true },
    }),
  ],
})

const ontology = new OntologyRegistry({
  sources: [Customer, Order, WildcardSource, SearchProfileCustomer, TextNoDefault, Balance],
})

function makeObjectMutationEvent(
  projectId: string,
  objectTypeId: string,
  primaryId: string,
  properties: Record<string, unknown>
): StoredObjectMutationEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    schemaVersion: 1,
    projectId,
    type: "object.created",
    topic: "objects",
    partitionKey: `${objectTypeId}:${primaryId}`,
    occurredAt: new Date().toISOString(),
    cursor: crypto.randomUUID(),
    payload: { objectTypeId, primaryId, properties, propertyChanges: {} },
  }
}

function makeLinkMutationEvent(
  projectId: string,
  sourceTypeId: string,
  sourceId: string,
  linkId: string,
  targetTypeId: string,
  targetId: string
): StoredLinkMutationEvent {
  return {
    id: `evt-${crypto.randomUUID()}`,
    schemaVersion: 1,
    projectId,
    type: "link.created",
    topic: "links",
    partitionKey: `${sourceTypeId}:${sourceId}:${linkId}`,
    occurredAt: new Date().toISOString(),
    cursor: crypto.randomUUID(),
    payload: { sourceTypeId, sourceId, linkId, targetTypeId, targetId, propertyChanges: {} },
  }
}

class CountingQueryStorage extends InMemoryObjectStorage {
  queryObjectCalls = 0
  countObjectCalls = 0
  existsObjectCalls = 0
  facetObjectCalls = 0

  override async queryObjects(params: QueryObjectsInput): Promise<QueryObjectsResult> {
    this.queryObjectCalls += 1
    return super.queryObjects(params)
  }

  override async countObjects(params: CountObjectsInput): Promise<CountObjectsResult> {
    this.countObjectCalls += 1
    return super.countObjects(params)
  }

  override async existsObjects(params: ExistsObjectsInput): Promise<ExistsObjectsResult> {
    this.existsObjectCalls += 1
    return super.existsObjects(params)
  }

  override async facetObjects(params: FacetObjectsInput): Promise<FacetObjectsResult> {
    this.facetObjectCalls += 1
    return super.facetObjects(params)
  }
}

function disableQueryObjects(storage: InMemoryObjectStorage): ObjectStorage {
  const objectStorage = storage as ObjectStorage
  objectStorage.queryCapabilities = () => ({ queryObjects: false })
  objectStorage.queryObjects = undefined
  return objectStorage
}

async function seedCustomers(storage: InMemoryObjectStorage): Promise<void> {
  await storage.applyObjectUpsert(
    makeObjectMutationEvent("p1", "Customer", "cust-1", {
      id: "cust-1",
      name: "Beta Co",
      email: "beta@example.com",
      status: "active",
      embedding: [1, 0],
    })
  )
  await storage.applyObjectUpsert(
    makeObjectMutationEvent("p1", "Customer", "cust-2", {
      id: "cust-2",
      name: "Paused Co",
      email: "paused@example.com",
      status: "paused",
      embedding: [0, 1],
    })
  )
  await storage.applyObjectUpsert(
    makeObjectMutationEvent("p1", "Customer", "cust-3", {
      id: "cust-3",
      name: "Acme Co",
      email: "acme@example.com",
      status: "active",
      embedding: [0.9, 0.1],
    })
  )
}

async function seedCustomerOrders(storage: InMemoryObjectStorage): Promise<void> {
  await seedCustomers(storage)
  await storage.applyObjectUpsert(
    makeObjectMutationEvent("p1", "Order", "order-1", {
      id: "order-1",
      total: 100,
      createdAt: "2026-01-01T00:00:00Z",
    })
  )
  await storage.applyObjectUpsert(
    makeObjectMutationEvent("p1", "Order", "order-2", {
      id: "order-2",
      total: 200,
      createdAt: "2026-01-02T00:00:00Z",
    })
  )
  await storage.applyObjectUpsert(
    makeObjectMutationEvent("p1", "Order", "order-3", {
      id: "order-3",
      total: 300,
      createdAt: "2026-01-03T00:00:00Z",
    })
  )
  await storage.applyLinkUpsert(
    makeLinkMutationEvent("p1", "Customer", "cust-1", "orders", "Order", "order-1")
  )
  await storage.applyLinkUpsert(
    makeLinkMutationEvent("p1", "Customer", "cust-2", "orders", "Order", "order-2")
  )
  await storage.applyLinkUpsert(
    makeLinkMutationEvent("p1", "Customer", "cust-3", "orders", "Order", "order-3")
  )
}

const boundedCustomerQuery: ObjectQuery = {
  kind: "project",
  properties: ["id", "name"],
  input: {
    kind: "limit",
    limit: 2,
    input: {
      kind: "sort",
      fields: [{ kind: "property", propertyId: "name", direction: "asc" }],
      input: {
        kind: "filter",
        predicate: { op: "eq", propertyId: "status", value: "active" },
        input: { kind: "start", objectTypeId: "Customer" },
      },
    },
  },
}

describe("object query IR normalization", () => {
  test("merges adjacent filters and limits and deduplicates fields", () => {
    const query: ObjectQuery = {
      kind: "limit",
      limit: 25,
      input: {
        kind: "limit",
        limit: 10,
        input: {
          kind: "filter",
          predicate: { op: "eq", propertyId: "status", value: "active" },
          input: {
            kind: "filter",
            predicate: { op: "eq", propertyId: "id", value: "cust-1" },
            input: {
              kind: "text",
              query: "acme",
              fields: ["name", "email", "name"],
              input: { kind: "start", objectTypeId: "Customer" },
            },
          },
        },
      },
    }

    const normalized = normalizeObjectQuery(query)

    expect(normalized.kind).toBe("limit")
    if (normalized.kind !== "limit") return
    expect(normalized.limit).toBe(10)
    expect(normalized.input.kind).toBe("filter")
    if (normalized.input.kind !== "filter") return
    expect(normalized.input.predicate.op).toBe("and")
    if (normalized.input.predicate.op !== "and") return
    expect(normalized.input.predicate.items).toHaveLength(2)
    expect(normalized.input.input.kind).toBe("text")
    if (normalized.input.input.kind !== "text") return
    expect(normalized.input.input.fields).toEqual(["name", "email"])
  })

  test("flattens predicate and set groups while preserving the last adjacent sort", () => {
    const query: ObjectQuery = {
      kind: "project",
      properties: ["id", "name", "id"],
      input: {
        kind: "filter",
        predicate: {
          op: "or",
          items: [
            {
              op: "or",
              items: [
                { op: "eq", propertyId: "status", value: "active" },
                { op: "eq", propertyId: "status", value: "paused" },
              ],
            },
          ],
        },
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "name", direction: "asc" }],
          input: {
            kind: "sort",
            fields: [{ kind: "property", propertyId: "status", direction: "desc" }],
            input: {
              kind: "set",
              op: "union",
              inputs: [
                { kind: "start", objectTypeId: "Customer" },
                {
                  kind: "set",
                  op: "union",
                  inputs: [
                    { kind: "start", objectTypeId: "Customer" },
                    { kind: "start", objectTypeId: "Customer" },
                  ],
                },
              ],
            },
          },
        },
      },
    }

    const normalized = normalizeObjectQuery(query)

    expect(normalized.kind).toBe("project")
    if (normalized.kind !== "project") return
    expect(normalized.properties).toEqual(["id", "name"])
    expect(normalized.input.kind).toBe("filter")
    if (normalized.input.kind !== "filter") return
    expect(normalized.input.predicate).toEqual({
      op: "or",
      items: [
        { op: "eq", propertyId: "status", value: "active" },
        { op: "eq", propertyId: "status", value: "paused" },
      ],
    })
    expect(normalized.input.input.kind).toBe("sort")
    if (normalized.input.input.kind !== "sort") return
    expect(normalized.input.input.fields).toEqual([
      { kind: "property", propertyId: "name", direction: "asc" },
    ])
    expect(normalized.input.input.input.kind).toBe("set")
    if (normalized.input.input.input.kind !== "set") return
    expect(normalized.input.input.input.inputs).toHaveLength(3)
  })
})

describe("object query validation", () => {
  test("resolves and canonicalizes exact decimal predicate and sort semantics", () => {
    const validated = validateObjectQuery(
      {
        kind: "sort",
        fields: [{ kind: "property", propertyId: "amount", direction: "asc" }],
        input: {
          kind: "filter",
          predicate: { op: "gte", propertyId: "amount", value: "+009007199254740993.0100" },
          input: { kind: "start", objectTypeId: "Balance" },
        },
      },
      { ontology }
    )

    expect(validated.query).toMatchObject({
      fields: [{ propertyId: "amount", scalarKind: "decimal" }],
      input: {
        predicate: {
          propertyId: "amount",
          value: "9007199254740993.01",
          scalarKind: "decimal",
        },
      },
    })
  })

  test("ignores caller-authored scalar kinds and resolves them from the ontology", () => {
    const validated = validateObjectQuery(
      {
        kind: "sort",
        fields: [{ kind: "property", propertyId: "name", scalarKind: "decimal" }],
        input: {
          kind: "filter",
          predicate: {
            op: "eq",
            propertyId: "status",
            value: "active",
            scalarKind: "decimal",
          },
          input: { kind: "start", objectTypeId: "Customer" },
        },
      },
      { ontology }
    )

    expect(validated.query).toMatchObject({
      fields: [{ propertyId: "name", scalarKind: "string" }],
      input: { predicate: { propertyId: "status", scalarKind: "string" } },
    })
  })

  test("accepts text, filter, sort, project, and limit queries", () => {
    const query: ObjectQuery = {
      kind: "limit",
      limit: 20,
      input: {
        kind: "project",
        properties: ["id", "name", "status"],
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "name", direction: "asc" }],
          input: {
            kind: "filter",
            predicate: { op: "eq", propertyId: "status", value: "active" },
            input: {
              kind: "text",
              query: "acme",
              input: { kind: "start", objectTypeId: "Customer" },
            },
          },
        },
      },
    }

    const validated = validateObjectQuery(query, { ontology })

    expect(validated.result.objectTypeIds).toEqual(["Customer"])
    expect(validated.query.kind).toBe("limit")
  })

  test("resolves outgoing and incoming traversal result types", () => {
    const outgoing = validateObjectQuery(
      {
        kind: "traverse",
        direction: "outgoing",
        linkId: "orders",
        input: { kind: "start", objectTypeId: "Customer" },
      },
      { ontology }
    )

    const incoming = validateObjectQuery(
      {
        kind: "traverse",
        direction: "incoming",
        linkId: "orders",
        input: { kind: "start", objectTypeId: "Order" },
      },
      { ontology }
    )

    expect(outgoing.result.objectTypeIds).toEqual(["Order"])
    expect(incoming.result.objectTypeIds).toEqual(["Customer"])
  })

  test("constrains incoming traversal to a declared source object type", () => {
    const Reseller = defineObjectType({
      id: "Reseller",
      name: "Reseller",
      properties: [prop("id", "string", { required: true, primary: true })],
      links: [link("orders", Order)],
    })
    const sharedLinkOntology = new OntologyRegistry({ sources: [Customer, Reseller, Order] })

    const unconstrained = validateObjectQuery(
      {
        kind: "traverse",
        direction: "incoming",
        linkId: "orders",
        input: { kind: "start", objectTypeId: "Order" },
      },
      { ontology: sharedLinkOntology }
    )
    expect([...unconstrained.result.objectTypeIds].sort()).toEqual(["Customer", "Reseller"])

    const constrained = validateObjectQuery(
      {
        kind: "traverse",
        direction: "incoming",
        linkId: "orders",
        sourceObjectTypeId: "Reseller",
        input: { kind: "start", objectTypeId: "Order" },
      },
      { ontology: sharedLinkOntology }
    )
    expect(constrained.result.objectTypeIds).toEqual(["Reseller"])
  })

  test("rejects traverse source misuse", () => {
    const unknownSource = collectObjectQueryValidationIssues(
      {
        kind: "traverse",
        direction: "incoming",
        linkId: "orders",
        sourceObjectTypeId: "Nope",
        input: { kind: "start", objectTypeId: "Order" },
      },
      { ontology }
    )
    expect(unknownSource.map((issue) => issue.code)).toContain("unknown_traverse_source")

    const outgoingSource = collectObjectQueryValidationIssues(
      {
        kind: "traverse",
        direction: "outgoing",
        linkId: "orders",
        sourceObjectTypeId: "Customer",
        input: { kind: "start", objectTypeId: "Customer" },
      },
      { ontology }
    )
    expect(outgoingSource.map((issue) => issue.code)).toContain("traverse_source_not_applicable")
  })

  test("accepts vector queries for declared vector search profiles", () => {
    const validated = validateObjectQuery(
      {
        kind: "vector",
        vector: [0.1, 0.2, 0.3],
        propertyId: "embedding",
        k: 5,
        input: { kind: "start", objectTypeId: "Customer" },
      },
      { ontology }
    )

    expect(validated.result.objectTypeIds).toEqual(["Customer"])
  })

  test("collects structured issues for invalid predicates and text fields", () => {
    const issues = collectObjectQueryValidationIssues(
      {
        kind: "filter",
        predicate: {
          op: "and",
          items: [
            { op: "eq", propertyId: "email", value: "ops@example.com" },
            { op: "eq", propertyId: "missing", value: "x" },
          ],
        },
        input: {
          kind: "text",
          query: "ops",
          fields: ["status"],
          input: { kind: "start", objectTypeId: "Customer" },
        },
      },
      { ontology }
    )

    expect(issues.map((issue) => issue.code)).toContain("query_field_not_enabled")
    expect(issues.map((issue) => issue.code)).toContain("property_not_filterable")
    expect(issues.map((issue) => issue.code)).toContain("unknown_property")
  })

  test("collects structural validation failures with stable issue codes", () => {
    const issues = collectObjectQueryValidationIssues(
      {
        kind: "project",
        properties: [],
        input: {
          kind: "page",
          pageSize: 0,
          pageToken: "",
          input: {
            kind: "limit",
            limit: 20,
            input: {
              kind: "sort",
              fields: [
                { kind: "property", propertyId: "name", direction: "asc" },
                { kind: "property", propertyId: "name", direction: "desc" },
              ],
              input: {
                kind: "filter",
                predicate: { op: "and", items: [] },
                input: { kind: "start", objectTypeId: "Customer" },
              },
            },
          },
        },
      },
      { ontology, maxLimit: 10 }
    )

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "empty_projection",
        "invalid_page_size",
        "empty_page_token",
        "limit_too_large",
        "duplicate_sort_field",
        "empty_predicate_group",
      ])
    )
  })

  test("rejects incompatible set inputs", () => {
    const issues = collectObjectQueryValidationIssues(
      {
        kind: "set",
        op: "union",
        inputs: [
          { kind: "start", objectTypeId: "Customer" },
          { kind: "start", objectTypeId: "Order" },
        ],
      },
      { ontology }
    )

    expect(issues.map((issue) => issue.code)).toContain("incompatible_set_input")
  })

  test("rejects outgoing wildcard traversal because the target type is ambiguous", () => {
    const issues = collectObjectQueryValidationIssues(
      {
        kind: "traverse",
        direction: "outgoing",
        linkId: "anything",
        input: { kind: "start", objectTypeId: "WildcardSource" },
      },
      { ontology }
    )

    expect(issues.map((issue) => issue.code)).toContain("wildcard_traverse_target")
  })

  test("uses search profile defaults and reports missing or mismatched profiles", () => {
    const defaultText = validateObjectQuery(
      {
        kind: "text",
        query: "acme",
        input: { kind: "start", objectTypeId: "SearchProfileCustomer" },
      },
      { ontology }
    )
    const explicitText = validateObjectQuery(
      {
        kind: "text",
        query: "acme",
        fields: ["name"],
        input: { kind: "start", objectTypeId: "TextNoDefault" },
      },
      { ontology }
    )
    const missingDefaultIssues = collectObjectQueryValidationIssues(
      {
        kind: "text",
        query: "acme",
        input: { kind: "start", objectTypeId: "TextNoDefault" },
      },
      { ontology }
    )
    const vectorProfileIssues = collectObjectQueryValidationIssues(
      {
        kind: "vector",
        propertyId: "altEmbedding",
        vector: [1, 0],
        k: 2,
        input: { kind: "start", objectTypeId: "SearchProfileCustomer" },
      },
      { ontology }
    )

    expect(defaultText.result.objectTypeIds).toEqual(["SearchProfileCustomer"])
    expect(defaultText.query.kind).toBe("text")
    if (defaultText.query.kind === "text") {
      expect(defaultText.query.fields).toBeUndefined()
      expect(defaultText.query.fieldsByObjectType).toEqual({
        SearchProfileCustomer: ["name", "notes"],
      })
    }
    expect(explicitText.result.objectTypeIds).toEqual(["TextNoDefault"])
    expect(missingDefaultIssues.map((issue) => issue.code)).toContain("missing_text_fields")
    expect(vectorProfileIssues.map((issue) => issue.code)).toContain("vector_profile_missing")
  })
})

describe("object query explain", () => {
  test("formats a valid normalized query tree", () => {
    const explanation = explainObjectQuery(
      {
        kind: "traverse",
        direction: "outgoing",
        linkId: "orders",
        input: {
          kind: "text",
          query: "acme",
          input: { kind: "start", objectTypeId: "Customer" },
        },
      },
      { ontology }
    )

    const formatted = formatObjectQueryExplanation(explanation)

    expect(explanation.valid).toBe(true)
    expect(explanation.result?.objectTypeIds).toEqual(["Order"])
    expect(formatted).toContain("ObjectQuery valid result=Order")
    expect(formatted).toContain("traverse outgoing orders")
    expect(formatted).toContain('text "acme"')
  })

  test("formats validation issues", () => {
    const explanation = explainObjectQuery(
      {
        kind: "filter",
        predicate: { op: "eq", propertyId: "missing", value: "x" },
        input: { kind: "start", objectTypeId: "Customer" },
      },
      { ontology }
    )

    const formatted = formatObjectQueryExplanation(explanation)

    expect(explanation.valid).toBe(false)
    expect(formatted).toContain("ObjectQuery invalid")
    expect(formatted).toContain("Issues:")
    expect(formatted).toContain("[unknown_property]")
  })
})

describe("object query planner and executor", () => {
  test("filters and sorts decimals exactly beyond JS number precision", async () => {
    const storage = new InMemoryObjectStorage()
    for (const [primaryId, amount] of [
      ["small", decimal("0.00000000000000000002")],
      ["large-a", decimal("9007199254740992")],
      ["large-b", decimal("9007199254740993")],
    ] as const) {
      await storage.applyObjectUpsert(
        makeObjectMutationEvent("p1", "Balance", primaryId, { id: primaryId, amount })
      )
    }

    const query: ObjectQuery = {
      kind: "limit",
      limit: 10,
      input: {
        kind: "sort",
        fields: [{ kind: "property", propertyId: "amount", direction: "asc" }],
        input: {
          kind: "filter",
          predicate: { op: "gt", propertyId: "amount", value: "9007199254740992" },
          input: { kind: "start", objectTypeId: "Balance" },
        },
      },
    }
    const result = await executeObjectQuery({ projectId: "p1", query }, { ontology, storage })

    expect(result.objects.map((row) => row.primaryId)).toEqual(["large-b"])
  })

  test("falls back when a provider cannot guarantee exact decimal semantics", () => {
    const validated = validateObjectQuery(
      {
        kind: "limit",
        limit: 10,
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "amount" }],
          input: {
            kind: "filter",
            predicate: { op: "gt", propertyId: "amount", value: "1" },
            input: { kind: "start", objectTypeId: "Balance" },
          },
        },
      },
      { ontology }
    )
    const plan = planObjectQuery(validated.query, {
      capabilities: {
        queryObjects: true,
        nodes: { start: true, filter: true, sort: true, limit: true },
        predicateOps: { gt: true },
        sortKinds: { property: true },
      },
      hasQueryObjects: true,
      maxFallbackRows: 10,
    })

    expect(plan.mode).toBe("fallback")
    expect(plan.providerIssues.map((issue) => issue.code)).toEqual([
      "scalar_operation_not_supported",
      "scalar_operation_not_supported",
    ])
  })

  test("plans scalar operation capabilities independently of decimal", () => {
    const validated = validateObjectQuery(
      {
        kind: "limit",
        limit: 10,
        input: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "total" }],
          input: { kind: "start", objectTypeId: "Order" },
        },
      },
      { ontology }
    )
    expect(validated.query).toHaveProperty("input.fields[0].scalarKind", "double")

    const capabilities: ObjectQueryCapabilities = {
      queryObjects: true,
      nodes: { start: true, sort: true, limit: true },
      sortKinds: { property: true },
      scalarOperations: { double: { equality: true } },
    }
    const fallback = planObjectQuery(validated.query, {
      capabilities,
      hasQueryObjects: true,
      maxFallbackRows: 10,
    })
    expect(fallback.mode).toBe("fallback")
    expect(fallback.providerIssues).toContainEqual(
      expect.objectContaining({
        code: "scalar_operation_not_supported",
        message: "Provider does not support ordering for 'double' values",
      })
    )

    const pushdown = planObjectQuery(validated.query, {
      capabilities: {
        ...capabilities,
        scalarOperations: { double: { equality: true, ordering: true } },
      },
      hasQueryObjects: true,
    })
    expect(pushdown.mode).toBe("pushdown")
  })

  test("plans and executes full provider pushdown", async () => {
    const storage = new CountingQueryStorage()
    await seedCustomers(storage)

    const plan = planObjectQuery(boundedCustomerQuery, {
      capabilities: storage.queryCapabilities(),
      hasQueryObjects: true,
    })
    const result = await executeObjectQuery(
      { projectId: "p1", query: boundedCustomerQuery },
      { ontology, storage }
    )

    expect(plan.mode).toBe("pushdown")
    expect(result.plan.mode).toBe("pushdown")
    expect(storage.queryObjectCalls).toBe(1)
    expect(result.objects.map((row) => row.primaryId)).toEqual(["cust-3", "cust-1"])
    expect(result.objects[0].properties).toEqual({ id: "cust-3", name: "Acme Co" })
  })

  test("executes bounded fallback when provider pushdown is unavailable", async () => {
    const storage = new InMemoryObjectStorage()
    await seedCustomers(storage)
    const legacyStorage = disableQueryObjects(storage)

    const result = await executeObjectQuery(
      { projectId: "p1", query: boundedCustomerQuery },
      { ontology, storage: legacyStorage, maxFallbackRows: 10 }
    )

    expect(result.plan.mode).toBe("fallback")
    expect(result.plan.providerIssues.map((issue) => issue.code)).toContain(
      "query_objects_not_enabled"
    )
    expect(result.objects.map((row) => row.primaryId)).toEqual(["cust-3", "cust-1"])
    expect(result.objects[0].properties).toEqual({ id: "cust-3", name: "Acme Co" })
  })

  test("plans expand pushdown only when every expansion has a resolved cardinality", () => {
    const capabilities: ObjectQueryCapabilities = {
      queryObjects: true,
      nodes: { start: true, limit: true, expand: true },
    }
    const resolved: ObjectQuery = {
      kind: "expand",
      input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Customer" } },
      expansions: [{ linkId: "orders", direction: "outgoing", cardinality: "many" }],
    }
    expect(planObjectQuery(resolved, { capabilities, hasQueryObjects: true }).mode).toBe("pushdown")

    // An unresolved cardinality (e.g. a polymorphic parent whose branches
    // disagree) keeps the query on the bounded fallback.
    const unresolved: ObjectQuery = {
      kind: "expand",
      input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Customer" } },
      expansions: [{ linkId: "orders", direction: "outgoing" }],
    }
    const plan = planObjectQuery(unresolved, {
      capabilities,
      hasQueryObjects: true,
      maxFallbackRows: 10,
    })
    expect(plan.mode).toBe("fallback")
    expect(plan.providerIssues.map((issue) => issue.code)).toContain(
      "expand_cardinality_unresolved"
    )
  })

  test("keeps expand on the fallback when the provider lacks the capability", () => {
    const capabilities: ObjectQueryCapabilities = {
      queryObjects: true,
      nodes: { start: true, limit: true },
    }
    const query: ObjectQuery = {
      kind: "expand",
      input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Customer" } },
      expansions: [{ linkId: "orders", direction: "outgoing", cardinality: "many" }],
    }
    const plan = planObjectQuery(query, {
      capabilities,
      hasQueryObjects: true,
      maxFallbackRows: 10,
    })
    expect(plan.mode).toBe("fallback")
    expect(plan.providerIssues.map((issue) => issue.code)).toContain("query_node_not_supported")
  })

  test("requires a resolved cardinality on nested expansions too", () => {
    const capabilities: ObjectQueryCapabilities = {
      queryObjects: true,
      nodes: { start: true, limit: true, expand: true },
    }
    const query: ObjectQuery = {
      kind: "expand",
      input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Customer" } },
      expansions: [
        {
          linkId: "orders",
          direction: "outgoing",
          cardinality: "many",
          expand: [{ linkId: "items", direction: "outgoing" }],
        },
      ],
    }
    const plan = planObjectQuery(query, {
      capabilities,
      hasQueryObjects: true,
      maxFallbackRows: 10,
    })
    expect(plan.mode).toBe("fallback")
    expect(plan.providerIssues.map((issue) => issue.code)).toContain(
      "expand_cardinality_unresolved"
    )
  })

  test("counts through provider pushdown without materializing rows", async () => {
    const storage = new CountingQueryStorage()
    await seedCustomers(storage)

    const result = await countObjects(
      {
        projectId: "p1",
        query: {
          kind: "limit",
          limit: 1,
          input: {
            kind: "filter",
            predicate: { op: "eq", propertyId: "status", value: "active" },
            input: { kind: "start", objectTypeId: "Customer" },
          },
        },
      },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("pushdown")
    expect(result.count).toBe(2)
    expect(storage.countObjectCalls).toBe(1)
    expect(storage.queryObjectCalls).toBe(0)
  })

  test("checks existence through provider pushdown without materializing rows or counts", async () => {
    const storage = new CountingQueryStorage()
    await seedCustomers(storage)

    const result = await existsObjects(
      {
        projectId: "p1",
        query: {
          kind: "limit",
          limit: 0,
          input: {
            kind: "filter",
            predicate: { op: "eq", propertyId: "status", value: "active" },
            input: { kind: "start", objectTypeId: "Customer" },
          },
        },
      },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("pushdown")
    expect(result.exists).toBe(true)
    expect(storage.existsObjectCalls).toBe(1)
    expect(storage.countObjectCalls).toBe(0)
    expect(storage.queryObjectCalls).toBe(0)
  })

  test("facets through provider pushdown without materializing rows or scalar counts", async () => {
    const storage = new CountingQueryStorage()
    await seedCustomers(storage)

    const result = await facetObjects(
      {
        projectId: "p1",
        query: {
          kind: "limit",
          limit: 0,
          input: {
            kind: "filter",
            predicate: { op: "eq", propertyId: "status", value: "active" },
            input: { kind: "start", objectTypeId: "Customer" },
          },
        },
        facets: [{ propertyId: "status", limit: 10 }],
      },
      { ontology, storage }
    )

    expect(result.plan.mode).toBe("pushdown")
    expect(result.facets).toEqual([
      { propertyId: "status", buckets: [{ value: "active", count: 2 }] },
    ])
    expect(storage.facetObjectCalls).toBe(1)
    expect(storage.queryObjectCalls).toBe(0)
    expect(storage.countObjectCalls).toBe(0)
    expect(storage.existsObjectCalls).toBe(0)
  })

  test("rejects facet requests for properties not marked facetable", async () => {
    const storage = new InMemoryObjectStorage()

    await expect(
      facetObjects(
        {
          projectId: "p1",
          query: { kind: "start", objectTypeId: "Customer" },
          facets: [{ propertyId: "email", limit: 10 }],
        },
        { ontology, storage }
      )
    ).rejects.toBeInstanceOf(ObjectQueryValidationError)

    try {
      await facetObjects(
        {
          projectId: "p1",
          query: { kind: "start", objectTypeId: "Customer" },
          facets: [{ propertyId: "email", limit: 10 }],
        },
        { ontology, storage }
      )
    } catch (error) {
      expect(error).toBeInstanceOf(ObjectQueryValidationError)
      if (error instanceof ObjectQueryValidationError) {
        expect(error.issues.map((issue) => issue.code)).toContain("property_not_facetable")
      }
    }
  })

  test("falls back when provider capabilities are incomplete but fallback is safe", () => {
    const limitedCapabilities: ObjectQueryCapabilities = {
      queryObjects: true,
      nodes: {
        start: true,
        filter: true,
        limit: true,
      },
      predicateOps: {
        eq: true,
      },
    }

    const plan = planObjectQuery(boundedCustomerQuery, {
      capabilities: limitedCapabilities,
      hasQueryObjects: true,
      maxFallbackRows: 10,
    })

    expect(plan.mode).toBe("fallback")
    expect(plan.fallbackIssues).toHaveLength(0)
    expect(plan.providerIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["query_node_not_supported", "sort_kind_not_supported"])
    )
  })

  test("falls back when provider limit capabilities are exceeded", () => {
    const capabilities: ObjectQueryCapabilities = {
      queryObjects: true,
      nodes: {
        start: true,
        limit: true,
        page: true,
      },
      limits: {
        maxLimit: 1,
        maxPageSize: 1,
      },
    }

    const limitPlan = planObjectQuery(
      {
        kind: "limit",
        limit: 2,
        input: { kind: "start", objectTypeId: "Customer" },
      },
      { capabilities, hasQueryObjects: true, maxFallbackRows: 10 }
    )
    const pagePlan = planObjectQuery(
      {
        kind: "page",
        pageSize: 2,
        input: { kind: "start", objectTypeId: "Customer" },
      },
      { capabilities, hasQueryObjects: true, maxFallbackRows: 10 }
    )

    expect(limitPlan.mode).toBe("fallback")
    expect(limitPlan.providerIssues.map((issue) => issue.code)).toContain(
      "provider_limit_too_large"
    )
    expect(pagePlan.mode).toBe("fallback")
    expect(pagePlan.providerIssues.map((issue) => issue.code)).toContain(
      "provider_page_size_too_large"
    )
  })

  test("pushes includeSubtypes starts down as concrete unions when the provider can run them", async () => {
    const BaseAsset = defineObjectType({
      id: "BaseAsset",
      name: "Base Asset",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const LaptopAsset = defineObjectType({
      id: "LaptopAsset",
      name: "Laptop Asset",
      extends: BaseAsset,
      properties: [],
    })
    const subtypeOntology = new OntologyRegistry({ sources: [BaseAsset, LaptopAsset] })
    const storage = new InMemoryObjectStorage()
    await storage.applyObjectUpsert(
      makeObjectMutationEvent("p1", "BaseAsset", "asset-1", { id: "asset-1" })
    )
    await storage.applyObjectUpsert(
      makeObjectMutationEvent("p1", "LaptopAsset", "laptop-1", { id: "laptop-1" })
    )

    const result = await executeObjectQuery(
      {
        projectId: "p1",
        query: {
          kind: "limit",
          limit: 10,
          input: { kind: "start", objectTypeId: "BaseAsset", includeSubtypes: true },
        },
      },
      { ontology: subtypeOntology, storage, maxFallbackRows: 10 }
    )

    expect(result.plan.mode).toBe("pushdown")
    expect(result.plan.query.kind).toBe("limit")
    if (result.plan.query.kind === "limit") {
      expect(result.plan.query.input.kind).toBe("set")
    }
    expect(new Set(result.objects.map((row) => row.primaryId))).toEqual(
      new Set(["asset-1", "laptop-1"])
    )
  })

  test("scopes default text fields by object type when querying subtypes", async () => {
    const DefaultTextBase = defineObjectType({
      id: "DefaultTextBase",
      name: "Default Text Base",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string", { query: { searchable: true, text: true } }),
        prop("alias", "string"),
      ],
      search: { defaultText: ["name"] },
    })
    const DefaultTextChild = defineObjectType({
      id: "DefaultTextChild",
      name: "Default Text Child",
      extends: DefaultTextBase,
      properties: [prop("alias", "string", { query: { searchable: true, text: true } })],
      search: { defaultText: ["alias"] },
    })
    const subtypeOntology = new OntologyRegistry({
      sources: [DefaultTextBase, DefaultTextChild],
    })
    const storage = new InMemoryObjectStorage()
    await storage.applyObjectUpsert(
      makeObjectMutationEvent("p1", "DefaultTextBase", "base-1", {
        id: "base-1",
        name: "ordinary",
        alias: "secret",
      })
    )
    await storage.applyObjectUpsert(
      makeObjectMutationEvent("p1", "DefaultTextChild", "child-1", {
        id: "child-1",
        name: "ordinary",
        alias: "secret",
      })
    )

    const result = await executeObjectQuery(
      {
        projectId: "p1",
        query: {
          kind: "text",
          query: "secret",
          input: { kind: "start", objectTypeId: "DefaultTextBase", includeSubtypes: true },
        },
      },
      { ontology: subtypeOntology, storage, maxFallbackRows: 10 }
    )

    expect(result.objects.map((row) => row.primaryId)).toEqual(["child-1"])
  })

  test("keeps includeSubtypes fallback for providers without query pushdown", async () => {
    const BaseAsset = defineObjectType({
      id: "FallbackBaseAsset",
      name: "Fallback Base Asset",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const LaptopAsset = defineObjectType({
      id: "FallbackLaptopAsset",
      name: "Fallback Laptop Asset",
      extends: BaseAsset,
      properties: [],
    })
    const subtypeOntology = new OntologyRegistry({ sources: [BaseAsset, LaptopAsset] })
    const storage = new InMemoryObjectStorage()
    await storage.applyObjectUpsert(
      makeObjectMutationEvent("p1", "FallbackBaseAsset", "asset-1", { id: "asset-1" })
    )
    await storage.applyObjectUpsert(
      makeObjectMutationEvent("p1", "FallbackLaptopAsset", "laptop-1", { id: "laptop-1" })
    )

    const result = await executeObjectQuery(
      {
        projectId: "p1",
        query: {
          kind: "limit",
          limit: 10,
          input: { kind: "start", objectTypeId: "FallbackBaseAsset", includeSubtypes: true },
        },
      },
      { ontology: subtypeOntology, storage: disableQueryObjects(storage), maxFallbackRows: 10 }
    )

    expect(result.plan.mode).toBe("fallback")
    expect(new Set(result.objects.map((row) => row.primaryId))).toEqual(
      new Set(["asset-1", "laptop-1"])
    )
  })

  test("rejects fallback without an explicit result bound", async () => {
    const storage = new InMemoryObjectStorage()
    await seedCustomers(storage)

    await expect(
      executeObjectQuery(
        {
          projectId: "p1",
          query: {
            kind: "filter",
            predicate: { op: "eq", propertyId: "status", value: "active" },
            input: { kind: "start", objectTypeId: "Customer" },
          },
        },
        { ontology, storage: disableQueryObjects(storage), maxFallbackRows: 10 }
      )
    ).rejects.toBeInstanceOf(ObjectQueryPlanningError)

    try {
      await executeObjectQuery(
        {
          projectId: "p1",
          query: {
            kind: "filter",
            predicate: { op: "eq", propertyId: "status", value: "active" },
            input: { kind: "start", objectTypeId: "Customer" },
          },
        },
        { ontology, storage: disableQueryObjects(storage), maxFallbackRows: 10 }
      )
    } catch (error) {
      expect(error).toBeInstanceOf(ObjectQueryPlanningError)
      if (error instanceof ObjectQueryPlanningError) {
        expect(error.issues.map((issue) => issue.code)).toContain("fallback_requires_bound")
      }
    }
  })

  test("rejects fallback execution when the bounded scan cap is exceeded", async () => {
    const storage = new InMemoryObjectStorage()
    await seedCustomers(storage)

    await expect(
      executeObjectQuery(
        {
          projectId: "p1",
          query: {
            kind: "limit",
            limit: 1,
            input: { kind: "start", objectTypeId: "Customer" },
          },
        },
        { ontology, storage: disableQueryObjects(storage), maxFallbackRows: 2 }
      )
    ).rejects.toBeInstanceOf(ObjectQueryExecutionError)

    try {
      await executeObjectQuery(
        {
          projectId: "p1",
          query: {
            kind: "limit",
            limit: 1,
            input: { kind: "start", objectTypeId: "Customer" },
          },
        },
        { ontology, storage: disableQueryObjects(storage), maxFallbackRows: 2 }
      )
    } catch (error) {
      expect(error).toBeInstanceOf(ObjectQueryExecutionError)
      if (error instanceof ObjectQueryExecutionError) {
        expect(error.code).toBe("fallback_row_limit_exceeded")
      }
    }
  })

  test("rejects fallback when policy is disabled or relevance sorting is required", () => {
    const disabled = planObjectQuery(boundedCustomerQuery, {
      capabilities: { queryObjects: false },
      hasQueryObjects: false,
      allowFallback: false,
    })
    const relevance = planObjectQuery(
      {
        kind: "limit",
        limit: 5,
        input: {
          kind: "sort",
          fields: [{ kind: "relevance" }],
          input: { kind: "start", objectTypeId: "Customer" },
        },
      },
      {
        capabilities: { queryObjects: false },
        hasQueryObjects: false,
        maxFallbackRows: 10,
      }
    )

    expect(disabled.mode).toBe("rejected")
    expect(disabled.fallbackIssues.map((issue) => issue.code)).toContain("fallback_disabled")
    expect(relevance.mode).toBe("rejected")
    expect(relevance.fallbackIssues.map((issue) => issue.code)).toContain(
      "fallback_sort_kind_not_supported"
    )
  })

  test("executes traversal and set operations through provider pushdown", async () => {
    const storage = new CountingQueryStorage()
    await seedCustomerOrders(storage)

    const traversedOrders = await executeObjectQuery(
      {
        projectId: "p1",
        query: {
          kind: "traverse",
          direction: "outgoing",
          linkId: "orders",
          input: {
            kind: "filter",
            predicate: { op: "eq", propertyId: "status", value: "active" },
            input: { kind: "start", objectTypeId: "Customer" },
          },
        },
      },
      { ontology, storage }
    )
    const union = await executeObjectQuery(
      {
        projectId: "p1",
        query: {
          kind: "set",
          op: "union",
          inputs: [
            {
              kind: "filter",
              predicate: { op: "eq", propertyId: "status", value: "active" },
              input: { kind: "start", objectTypeId: "Customer" },
            },
            {
              kind: "filter",
              predicate: { op: "eq", propertyId: "status", value: "paused" },
              input: { kind: "start", objectTypeId: "Customer" },
            },
          ],
        },
      },
      { ontology, storage }
    )

    expect(traversedOrders.plan.mode).toBe("pushdown")
    expect(traversedOrders.objects.map((row) => row.primaryId)).toEqual(["order-1", "order-3"])
    expect(union.plan.mode).toBe("pushdown")
    expect(union.objects.map((row) => row.primaryId)).toEqual(["cust-1", "cust-3", "cust-2"])
    expect(storage.queryObjectCalls).toBe(2)
  })

  test("filters incoming traversal by source object type during execution", async () => {
    const Reseller = defineObjectType({
      id: "Reseller",
      name: "Reseller",
      properties: [prop("id", "string", { required: true, primary: true })],
      links: [link("orders", Order)],
    })
    const sharedLinkOntology = new OntologyRegistry({ sources: [Customer, Reseller, Order] })

    const storage = new CountingQueryStorage()
    await seedCustomerOrders(storage)
    await storage.applyObjectUpsert(
      makeObjectMutationEvent("p1", "Reseller", "reseller-1", { id: "reseller-1" })
    )
    await storage.applyLinkUpsert(
      makeLinkMutationEvent("p1", "Reseller", "reseller-1", "orders", "Order", "order-1")
    )

    const orderOneSources: ObjectQuery = {
      kind: "traverse",
      direction: "incoming",
      linkId: "orders",
      input: {
        kind: "filter",
        predicate: { op: "eq", propertyId: "id", value: "order-1" },
        input: { kind: "start", objectTypeId: "Order" },
      },
    }

    const unconstrained = await executeObjectQuery(
      { projectId: "p1", query: orderOneSources },
      { ontology: sharedLinkOntology, storage }
    )
    expect(unconstrained.objects.map((row) => row.primaryId).sort()).toEqual([
      "cust-1",
      "reseller-1",
    ])

    const constrained = await executeObjectQuery(
      { projectId: "p1", query: { ...orderOneSources, sourceObjectTypeId: "Reseller" } },
      { ontology: sharedLinkOntology, storage }
    )
    expect(constrained.plan.mode).toBe("pushdown")
    expect(constrained.objects.map((row) => row.primaryId)).toEqual(["reseller-1"])
  })

  test("rejects fallback for search, traversal, and set nodes", async () => {
    const unsupportedQueries: readonly ObjectQuery[] = [
      {
        kind: "limit",
        limit: 5,
        input: {
          kind: "text",
          query: "acme",
          input: { kind: "start", objectTypeId: "Customer" },
        },
      },
      {
        kind: "limit",
        limit: 5,
        input: {
          kind: "vector",
          propertyId: "embedding",
          vector: [1, 0],
          k: 2,
          input: { kind: "start", objectTypeId: "Customer" },
        },
      },
      {
        kind: "limit",
        limit: 5,
        input: {
          kind: "traverse",
          direction: "outgoing",
          linkId: "orders",
          input: { kind: "start", objectTypeId: "Customer" },
        },
      },
      {
        kind: "limit",
        limit: 5,
        input: {
          kind: "set",
          op: "union",
          inputs: [
            { kind: "start", objectTypeId: "Customer" },
            { kind: "start", objectTypeId: "Customer" },
          ],
        },
      },
    ]

    for (const query of unsupportedQueries) {
      const storage = new InMemoryObjectStorage()
      await expect(
        executeObjectQuery(
          { projectId: "p1", query },
          { ontology, storage: disableQueryObjects(storage), maxFallbackRows: 10 }
        )
      ).rejects.toBeInstanceOf(ObjectQueryPlanningError)
    }
  })
})
