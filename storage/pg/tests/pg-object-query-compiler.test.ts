import { expect, test } from "bun:test"
import type { ObjectQuery } from "@sixb/core"
import {
  compilePgObjectCountQuery,
  compilePgObjectFacetQuery,
  compilePgObjectQuery,
} from "../src/pg-object-query-compiler"

const sitePointQuery: ObjectQuery = {
  kind: "filter",
  predicate: { op: "eq", propertyId: "siteId", value: "site-1" },
  input: { kind: "start", objectTypeId: "BacnetPoint" },
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
