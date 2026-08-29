import { expect, test } from "bun:test"
import type { ObjectQuery } from "@sixb/core"
import type { CompiledObjectReadScope } from "@sixb/core/storage"
import {
  compilePgObjectCountQuery,
  compilePgObjectExistsQuery,
  compilePgObjectFacetQuery,
  compilePgObjectQuery,
  compilePgObjectReadScopeTraversalProbe,
  compilePgObjectReadSql,
} from "../src/pg-object-query-compiler"

const sitePointQuery: ObjectQuery = {
  kind: "filter",
  predicate: { op: "eq", propertyId: "siteId", value: "site-1" },
  input: { kind: "start", objectTypeId: "BacnetPoint" },
}

test("refs compile to one de-duplicated JSONB table source in canonical order", () => {
  const refs = [
    { objectTypeId: "Issue", primaryId: "github:issue:sixb-ai/sixb#297" },
    { objectTypeId: "Customer", primaryId: "cust-1" },
    { objectTypeId: "Customer", primaryId: "cust-1" },
  ]
  const compiled = compilePgObjectQuery("project-a", { kind: "refs", refs })
  const counted = compilePgObjectCountQuery("project-a", { kind: "refs", refs })

  expect(compiled.sql).toContain("SELECT DISTINCT")
  expect(compiled.sql).toContain("FROM jsonb_array_elements($1::text::jsonb) AS ref(value)")
  expect(compiled.sql).toContain("ORDER BY selected.object_type_id ASC, selected.primary_id ASC")
  expect(compiled.args).toEqual([JSON.stringify(refs), "project-a"])
  expect(compiled.totalArgs).toEqual([JSON.stringify(refs), "project-a"])
  expect(counted.sql).toContain("SELECT DISTINCT")
  expect(counted.sql).toContain("FROM jsonb_array_elements($1::text::jsonb)")
  expect(counted.args).toEqual([JSON.stringify(refs), "project-a"])
})

const selectedReadScope: CompiledObjectReadScope = {
  kind: "selected",
  roots: [{ nodeId: 0, objectTypeId: "Proposal", primaryId: "proposal-a" }],
  objects: [
    { nodeId: 0, objectTypeId: "Proposal", propertyIds: ["id", "title"] },
    { nodeId: 1, objectTypeId: "LineItem", propertyIds: ["id", "quantity"] },
    { nodeId: 2, objectTypeId: "Product", propertyIds: ["id", "name"] },
  ],
  steps: [
    {
      nodeId: 1,
      parentNodeId: 0,
      sourceObjectTypeId: "Proposal",
      linkId: "items",
      targetObjectTypeId: "LineItem",
      propertyIds: ["position"],
    },
    {
      nodeId: 2,
      parentNodeId: 1,
      sourceObjectTypeId: "LineItem",
      linkId: "product",
      targetObjectTypeId: "Product",
      propertyIds: ["featured"],
    },
  ],
}

const selectedReadLimits = {
  maxTraversalFacts: 37,
  maxVisibleJsonBytes: 1_024,
}

test("decimal predicates and ordering compile to exact PostgreSQL numeric operations", () => {
  const compiled = compilePgObjectQuery("project-a", {
    kind: "sort",
    fields: [{ kind: "property", propertyId: "amount", direction: "asc", scalarKind: "decimal" }],
    input: {
      kind: "filter",
      predicate: {
        op: "gt",
        propertyId: "amount",
        value: "9007199254740992.0000000000000001",
        scalarKind: "decimal",
      },
      input: { kind: "start", objectTypeId: "Balance" },
    },
  })

  expect(compiled.sql).toContain("::numeric >")
  expect(compiled.sql).toContain("::numeric ASC")
  expect(compiled.args).toEqual([
    "project-a",
    "Balance",
    "amount",
    "amount",
    "9007199254740992.0000000000000001",
    "amount",
    "amount",
    "amount",
  ])
})

test("decimal equality and membership compare numeric value rather than JSON text", () => {
  const equality = compilePgObjectQuery("project-a", {
    kind: "filter",
    predicate: {
      op: "eq",
      propertyId: "amount",
      value: "1.2300",
      scalarKind: "decimal",
    },
    input: { kind: "start", objectTypeId: "Balance" },
  })
  const membership = compilePgObjectQuery("project-a", {
    kind: "filter",
    predicate: {
      op: "in",
      propertyId: "amount",
      values: ["1.23", "9007199254740993"],
      scalarKind: "decimal",
    },
    input: { kind: "start", objectTypeId: "Balance" },
  })

  expect(equality.sql).toContain("::numeric =")
  expect(equality.args).toContain("1.2300")
  expect(membership.sql).toContain("::numeric IN")
  expect(membership.args).toEqual([
    "project-a",
    "Balance",
    "amount",
    "amount",
    "1.23",
    "9007199254740993",
  ])
})

test("count aggregate SQL omits inherited row ordering", () => {
  const compiled = compilePgObjectCountQuery("project-a", sitePointQuery)

  expect(compiled.sql).toContain("COUNT(*)::bigint AS count")
  expect(compiled.sql).not.toContain("ORDER BY")
  expect(compiled.sql).not.toContain("_cursor_properties")
  expect(compiled.sql).toContain("properties ->>")
  expect(compiled.args).toEqual(["project-a", "BacnetPoint", "siteId", "siteId", "site-1"])
})

test("count aggregate SQL supports scoped text defaults", () => {
  const compiled = compilePgObjectCountQuery("project-a", {
    kind: "text",
    query: "alpha collaboration",
    fieldsByObjectType: {
      Room: ["name", "description"],
    },
    input: { kind: "start", objectTypeId: "Room" },
  })

  expect(compiled.sql).toContain("COUNT(*)::bigint AS count")
  expect(compiled.sql).toContain("object_type_id = $3")
  expect(compiled.sql).toContain("position($4::text in lower(coalesce")
  expect(compiled.sql).not.toContain("ORDER BY")
  expect(compiled.args).toEqual([
    "project-a",
    "Room",
    "Room",
    "alpha",
    "name",
    "alpha",
    "description",
    "collaboration",
    "name",
    "collaboration",
    "description",
  ])
})

test("facet aggregate SQL projects scalar values without sorting object rows", () => {
  const compiled = compilePgObjectFacetQuery("project-a", sitePointQuery, "objectType", 100)

  expect(compiled.sql).toContain("input.properties ->>")
  expect(compiled.sql).toContain("GROUP BY facet.value_type, facet.value_text")
  expect(compiled.sql).toContain("ORDER BY count DESC, facet.value_text ASC")
  expect(compiled.sql).not.toContain("SELECT *")
  expect(compiled.sql).not.toContain("ORDER BY input.project_id")
  expect(compiled.sql).not.toContain("_cursor_properties")
  expect(compiled.args).toEqual([
    "objectType",
    "objectType",
    "project-a",
    "BacnetPoint",
    "siteId",
    "siteId",
    "site-1",
    "objectType",
    100,
  ])
})

test("incoming traversal SQL filters by source object type when constrained", () => {
  const incoming: ObjectQuery = {
    kind: "traverse",
    direction: "incoming",
    linkId: "customer",
    input: { kind: "start", objectTypeId: "Customer" },
  }

  const unconstrained = compilePgObjectQuery("project-a", incoming)
  expect(unconstrained.sql).not.toContain("AND edge.source_type_id =")
  expect(unconstrained.args).toEqual(["project-a", "Customer", "customer"])

  const constrained = compilePgObjectQuery("project-a", {
    ...incoming,
    sourceObjectTypeId: "Project",
  })
  expect(constrained.sql).toContain("AND edge.source_type_id = $4")
  expect(constrained.args).toEqual(["project-a", "Customer", "customer", "Project"])

  const constrainedCount = compilePgObjectCountQuery("project-a", {
    ...incoming,
    sourceObjectTypeId: "Project",
  })
  expect(constrainedCount.sql).toContain("AND edge.source_type_id = $4")
  expect(constrainedCount.args).toEqual(["project-a", "Customer", "customer", "Project"])
})

test("expand SQL hydrates an outgoing many link as an ordered jsonb array", () => {
  const compiled = compilePgObjectQuery("project-a", {
    kind: "expand",
    input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Room" } },
    expansions: [{ linkId: "hasDevice", direction: "outgoing", cardinality: "many", limit: 50 }],
  })

  // Output-shaping: the input row set rides through under `_expand`.
  expect(compiled.sql).toContain("SELECT input.*,")
  expect(compiled.sql).toContain("AS _expand")
  // Top-N per parent pushed into the DB, then aggregated in rank order.
  expect(compiled.sql).toContain("row_number() OVER (ORDER BY")
  expect(compiled.sql).toContain("jsonb_agg(ranked_0.elem ORDER BY ranked_0._ord)")
  expect(compiled.sql).toContain("WHERE ranked_0._ord <= $3")
  expect(compiled.sql).toContain("'[]'::jsonb")
  // Outgoing: parent on the link source, neighbour hydrated from the target.
  expect(compiled.sql).toContain("edge_0.source_type_id = input.object_type_id")
  expect(compiled.sql).toContain("tgt_0.object_type_id = edge_0.target_type_id")
  expect(compiled.sql).toContain("'linkProperties', edge_0.properties")
  expect(compiled.sql).toContain("edge_0.link_id = $2::text")
  // Link id rides as a param twice (the json key and the edge filter); then the
  // baked fanout, then the input's own params.
  expect(compiled.args).toEqual(["hasDevice", "hasDevice", 50, "project-a", "Room", 10])
})

test("expand SQL takes the first ranked element for a one link", () => {
  const compiled = compilePgObjectQuery("project-a", {
    kind: "expand",
    input: { kind: "limit", limit: 5, input: { kind: "start", objectTypeId: "User" } },
    expansions: [{ linkId: "manager", direction: "outgoing", cardinality: "one", limit: 1000 }],
  })

  expect(compiled.sql).toContain("WHERE ranked_0._ord = 1")
  expect(compiled.sql).not.toContain("jsonb_agg")
  expect(compiled.sql).not.toContain("_ord <=")
  // No fanout param for a "one" link — it always takes a single element.
  expect(compiled.args).toEqual(["manager", "manager", "project-a", "User", 5])
})

test("expand SQL returns null for a cardinality-one link limited to zero", () => {
  const compiled = compilePgObjectQuery("project-a", {
    kind: "expand",
    input: { kind: "limit", limit: 5, input: { kind: "start", objectTypeId: "User" } },
    expansions: [{ linkId: "manager", direction: "outgoing", cardinality: "one", limit: 0 }],
  })

  expect(compiled.sql).toContain("NULL::jsonb")
  expect(compiled.sql).not.toContain("edge_0")
  expect(compiled.args).toEqual(["manager", "project-a", "User", 5])
})

test("expand SQL flips parent/neighbour columns and filters source type for incoming", () => {
  const compiled = compilePgObjectQuery("project-a", {
    kind: "expand",
    input: { kind: "limit", limit: 5, input: { kind: "start", objectTypeId: "Device" } },
    expansions: [
      {
        linkId: "hasDevice",
        direction: "incoming",
        sourceObjectTypeId: "Room",
        cardinality: "many",
        limit: 1000,
      },
    ],
  })

  // Incoming: parent on the link target, neighbour hydrated from the source.
  expect(compiled.sql).toContain("edge_0.target_type_id = input.object_type_id")
  expect(compiled.sql).toContain("edge_0.target_id = input.primary_id")
  expect(compiled.sql).toContain("tgt_0.object_type_id = edge_0.source_type_id")
  expect(compiled.sql).toContain("edge_0.source_type_id = $3::text")
  expect(compiled.args).toEqual(["hasDevice", "hasDevice", "Room", 1000, "project-a", "Device", 5])
})

test("expand SQL orders a bounded many link by target properties, nulls last", () => {
  const compiled = compilePgObjectQuery("project-a", {
    kind: "expand",
    input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Room" } },
    expansions: [
      {
        linkId: "hasDevice",
        direction: "outgoing",
        cardinality: "many",
        limit: 5,
        orderBy: [{ kind: "property", propertyId: "name", direction: "desc" }],
      },
    ],
  })

  // Null-rank first (always ASC so nulls sort last), then the value descending,
  // against the neighbour's JSONB properties — mirroring the fallback comparator.
  expect(compiled.sql).toContain("jsonb_typeof(tgt_0.properties -> ($2::text))")
  expect(compiled.sql).toContain("tgt_0.properties -> ($4::text) DESC")
  expect(compiled.args).toEqual([
    "hasDevice",
    "name",
    "name",
    "name",
    "hasDevice",
    5,
    "project-a",
    "Room",
    10,
  ])
})

test("expand SQL orders exact decimal target properties numerically", () => {
  const compiled = compilePgObjectQuery("project-a", {
    kind: "expand",
    input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Account" } },
    expansions: [
      {
        linkId: "balances",
        direction: "outgoing",
        cardinality: "many",
        limit: 5,
        orderBy: [
          { kind: "property", propertyId: "amount", direction: "asc", scalarKind: "decimal" },
        ],
      },
    ],
  })

  expect(compiled.sql).toContain("(tgt_0.properties ->> ($4::text))::numeric ASC")
})

test("expand SQL nests a child expansion correlated on the parent neighbour", () => {
  const compiled = compilePgObjectQuery("project-a", {
    kind: "expand",
    input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Project" } },
    expansions: [
      {
        linkId: "owner",
        direction: "outgoing",
        cardinality: "one",
        limit: 1000,
        expand: [{ linkId: "members", direction: "outgoing", cardinality: "many", limit: 1000 }],
      },
    ],
  })

  // The nested expansion uses its own aliases and correlates on the parent's
  // hydrated neighbour (tgt_0), under a `links` key in the child object.
  expect(compiled.sql).toContain("'links', jsonb_build_object(")
  expect(compiled.sql).toContain("edge_0_0.source_id = tgt_0.primary_id")
  expect(compiled.sql).toContain("jsonb_agg(ranked_0_0.elem")
})

test("selected scope replaces every query read before expansion and keeps response keys", () => {
  const compiled = compilePgObjectQuery(
    "project-a",
    {
      kind: "expand",
      input: { kind: "start", objectTypeId: "Proposal" },
      expansions: [
        {
          linkId: "items",
          direction: "outgoing",
          cardinality: "many",
          limit: 10,
          expand: [
            {
              linkId: "product",
              direction: "outgoing",
              cardinality: "one",
              limit: 1,
            },
          ],
        },
      ],
    },
    { readScope: selectedReadScope }
  )

  expect(compiled.sql).toContain("WITH RECURSIVE")
  expect(compiled.sql).toContain("FROM sixb_readable_objects")
  expect(compiled.sql).toContain("FROM sixb_readable_links AS edge_0")
  expect(compiled.sql).toContain("JOIN sixb_readable_objects AS tgt_0")
  expect(compiled.sql).toContain("FROM sixb_readable_links AS edge_0_0")
  expect(compiled.sql).toContain("'links', jsonb_build_object(")
  expect(compiled.totalSql).toContain("WITH RECURSIVE")
  expect(compiled.totalSql).toContain("FROM sixb_readable_objects")
  expect(maxPlaceholder(compiled.sql)).toBe(compiled.args.length)
  expect(maxPlaceholder(compiled.totalSql)).toBe(compiled.totalArgs.length)
})

test("selected scope constrains exact refs without introducing a second WITH clause", () => {
  const refs = [
    { objectTypeId: "Proposal", primaryId: "proposal-hidden" },
    { objectTypeId: "Proposal", primaryId: "proposal-a" },
  ]
  const compiled = compilePgObjectQuery(
    "project-a",
    { kind: "refs", refs },
    { readScope: selectedReadScope }
  )

  expect(compiled.sql).toContain("WITH RECURSIVE")
  expect(compiled.sql).not.toContain("WITH requested")
  expect(compiled.sql).toContain("FROM jsonb_array_elements($3::text::jsonb) AS ref(value)")
  expect(compiled.sql).toContain("JOIN sixb_readable_objects AS selected")
  expect(compiled.args.slice(-2)).toEqual([JSON.stringify(refs), "project-a"])
  expect(maxPlaceholder(compiled.sql)).toBe(compiled.args.length)
  expect(maxPlaceholder(compiled.totalSql)).toBe(compiled.totalArgs.length)
})

test("selected scope wraps aggregate and direct object/link reads", () => {
  const count = compilePgObjectCountQuery("project-a", sitePointQuery, selectedReadScope)
  const exists = compilePgObjectExistsQuery("project-a", sitePointQuery, selectedReadScope)
  const facet = compilePgObjectFacetQuery(
    "project-a",
    sitePointQuery,
    "siteId",
    10,
    selectedReadScope
  )
  const directLinkRead = compilePgObjectReadSql(
    "project-a",
    selectedReadScope,
    "SELECT * FROM links WHERE project_id = ? AND source_id = ?",
    ["project-a", "proposal-a"]
  )

  for (const compiled of [count, exists, facet, directLinkRead]) {
    expect(compiled.sql).toContain("WITH RECURSIVE")
    expect(maxPlaceholder(compiled.sql)).toBe(compiled.args.length)
  }
  expect(count.sql).toContain("FROM sixb_readable_objects")
  expect(exists.sql).toContain("FROM sixb_readable_objects")
  expect(facet.sql).toContain("FROM sixb_readable_objects")
  expect(directLinkRead.sql).toContain("FROM sixb_readable_links")
})

test("selected scope redacts object and exact physical-link properties in SQL", () => {
  const compiled = compilePgObjectReadSql(
    "project-a",
    selectedReadScope,
    "SELECT * FROM objects WHERE project_id = ?",
    ["project-a"]
  )

  expect(compiled.sql).toContain("sixb_scope_visible_object_properties")
  expect(compiled.sql).toContain("sixb_scope_visible_link_properties")
  expect(compiled.sql).toContain("jsonb_each(raw_object.properties)")
  expect(compiled.sql).toContain("jsonb_each(raw_link.properties)")
  expect(compiled.sql).toContain("allowed.target_id = raw_link.target_id")
  expect(compiled.sql).toContain("jsonb_to_recordset")
  expect(compiled.sql).toContain("jsonb_array_elements_text")
  const document = parseScopeDocument(compiled.args[0])
  expect(document.steps.map((step) => step.property_ids)).toEqual([["position"], ["featured"]])
})

test("selected scope keeps bind parameters bounded for tens of thousands of properties", () => {
  const propertyIds = Array.from({ length: 22_000 }, (_, index) => `property-${index}`)
  const largeScope: CompiledObjectReadScope = {
    kind: "selected",
    roots: [{ nodeId: 0, objectTypeId: "Proposal", primaryId: "proposal-a" }],
    objects: [{ nodeId: 0, objectTypeId: "Proposal", propertyIds }],
    steps: [],
  }
  const compiled = compilePgObjectReadSql(
    "project-a",
    largeScope,
    "SELECT * FROM objects WHERE project_id = ?",
    ["project-a"]
  )

  // Scope document + scope project + caller query. The old VALUES transport needed >66k args.
  expect(compiled.args).toHaveLength(3)
  expect(maxPlaceholder(compiled.sql)).toBe(3)
  expect(parseScopeDocument(compiled.args[0]).objects[0]?.property_ids).toHaveLength(22_000)
})

test("selected scope limits the recursive walk at maxTraversalFacts plus one", () => {
  const compiled = compilePgObjectReadSql(
    "project-a",
    selectedReadScope,
    "SELECT * FROM objects WHERE project_id = ?",
    ["project-a"],
    selectedReadLimits
  )

  expect(compiled.sql).toContain("sixb_scope_walk_probe AS MATERIALIZED")
  expect(compiled.sql).toContain("LIMIT ($3::bigint + 1)")
  expect(compiled.sql).toContain("budget.fact_count > $4::bigint")
  expect(compiled.sql).toContain("edge_source_type_id")
  expect(compiled.sql).toContain("edge_target_id")
  expect(compiled.args).toEqual([expect.any(String), "project-a", 37, 37, "project-a"])
  expect(maxPlaceholder(compiled.sql)).toBe(compiled.args.length)

  const preflight = compilePgObjectReadScopeTraversalProbe(
    "project-a",
    selectedReadScope,
    selectedReadLimits.maxTraversalFacts
  )
  expect(preflight.sql).toContain("LIMIT ($3::bigint + 1)")
  expect(preflight.args).toEqual([expect.any(String), "project-a", 37])
  expect(maxPlaceholder(preflight.sql)).toBe(preflight.args.length)
})

function maxPlaceholder(sql: string): number {
  return Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))
}

function parseScopeDocument(value: unknown): {
  objects: { property_ids: string[] }[]
  steps: { property_ids: string[] }[]
} {
  return JSON.parse(String(value)) as {
    objects: { property_ids: string[] }[]
    steps: { property_ids: string[] }[]
  }
}
