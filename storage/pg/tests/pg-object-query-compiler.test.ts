import { expect, test } from "bun:test"
import type { ObjectQuery } from "@sixb/core"
import {
  compilePgObjectCountQuery,
  compilePgObjectFacetQuery,
  compilePgObjectQuery,
} from "../src/objects/query-compiler"

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

  // An expansion orders its targets by the same exact numeric value.
  const expanded = compilePgObjectQuery("project-a", {
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
  expect(expanded.sql).toContain("(tgt_0.properties ->> ($4::text))::numeric ASC")
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
  expect(compiled.sql).toContain("lower(coalesce(properties ->> ($4::text), '')) LIKE $5::text")
  expect(compiled.sql).not.toContain("ORDER BY")
  expect(compiled.args).toEqual([
    "project-a",
    "Room",
    "Room",
    "name",
    "%alpha%",
    "description",
    "%alpha%",
    "name",
    "%collaboration%",
    "description",
    "%collaboration%",
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
  expect(unconstrained.sql).not.toContain("AND selected.object_type_id =")
  expect(unconstrained.args).toEqual(["project-a", "project-a", "Customer", "customer"])

  const constrained = compilePgObjectQuery("project-a", {
    ...incoming,
    sourceObjectTypeId: "Project",
  })
  expect(constrained.sql).toContain("AND selected.object_type_id = $2")
  expect(constrained.args).toEqual(["project-a", "Project", "project-a", "Customer", "customer"])

  const constrainedCount = compilePgObjectCountQuery("project-a", {
    ...incoming,
    sourceObjectTypeId: "Project",
  })
  expect(constrainedCount.sql).toContain("AND edge.source_type_id = $4")
  expect(constrainedCount.sql).toContain("AND selected.object_type_id = $6")
  expect(constrainedCount.args).toEqual([
    "project-a",
    "Customer",
    "customer",
    "Project",
    "project-a",
    "Project",
  ])
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
  expect(compiled.sql).toContain("NULLIF(tgt_0.properties -> ($4::text), 'null'::jsonb) DESC")
  expect(compiled.args).toEqual([
    "hasDevice",
    "name",
    "name",
    "name",
    "hasDevice",
    "name",
    "name",
    "name",
    5,
    "project-a",
    "Room",
    10,
  ])
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

test("a traversal looks only at the object types its link can reach", () => {
  const traversal = (endpointObjectTypeIds?: readonly string[]): ObjectQuery => ({
    kind: "traverse",
    input: { kind: "start", objectTypeId: "Quote" },
    linkId: "organization",
    direction: "outgoing",
    ...(endpointObjectTypeIds ? { endpointObjectTypeIds } : {}),
  })

  const one = compilePgObjectQuery("project-a", traversal(["Organization"]))
  expect(one.sql).toContain("AND selected.object_type_id = $2")
  expect(one.args.slice(0, 2)).toEqual(["project-a", "Organization"])

  const two = compilePgObjectQuery("project-a", traversal(["Organization", "Vendor"]))
  expect(two.sql).toContain("AND selected.object_type_id IN ($2, $3)")
  expect(two.args.slice(0, 3)).toEqual(["project-a", "Organization", "Vendor"])

  // A wildcard link names no types, so every type stays in scope.
  const wildcard = compilePgObjectQuery("project-a", traversal())
  expect(wildcard.sql).not.toContain("selected.object_type_id = $2")
  expect(wildcard.sql).not.toContain("selected.object_type_id IN")
})

test("an expansion joins only the object types its link can reach", () => {
  const compiled = compilePgObjectQuery("project-a", {
    kind: "expand",
    input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Quote" } },
    expansions: [
      {
        linkId: "organization",
        direction: "outgoing",
        cardinality: "one",
        limit: 1000,
        endpointObjectTypeIds: ["Organization"],
      },
    ],
  })

  expect(compiled.sql).toMatch(/AND tgt_0\.object_type_id = \$\d+\s+WHERE edge_0\.project_id/)
  // The type sits in the join, ahead of the link id: placeholder order must follow the SQL.
  const typeAt = compiled.args.indexOf("Organization")
  expect(typeAt).toBeGreaterThan(-1)
  expect(compiled.args[typeAt + 1]).toBe("organization")
})
