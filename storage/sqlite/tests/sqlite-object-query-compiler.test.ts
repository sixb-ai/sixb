import { expect, test } from "bun:test"
import type { ObjectQuery } from "@sixb/core"
import { compileObjectQuery } from "../src/object-query-compiler"

test("refs compile to one de-duplicated JSON table source in canonical order", () => {
  const refs = [
    { objectTypeId: "Issue", primaryId: "github:issue:sixb-ai/sixb#297" },
    { objectTypeId: "Customer", primaryId: "cust-1" },
    { objectTypeId: "Customer", primaryId: "cust-1" },
  ]
  const compiled = compileObjectQuery("project-a", { kind: "refs", refs })

  expect(compiled.sql).toContain("SELECT DISTINCT")
  expect(compiled.sql).toContain("FROM json_each(?) AS ref")
  expect(compiled.sql).toContain("ORDER BY selected.object_type_id ASC, selected.primary_id ASC")
  expect(compiled.args).toEqual([JSON.stringify(refs), "project-a"])
  expect(compiled.totalArgs).toEqual([JSON.stringify(refs), "project-a"])
})

test("expand SQL hydrates an outgoing many link as an ordered json array", () => {
  const compiled = compileObjectQuery("project-a", {
    kind: "expand",
    input: { kind: "limit", limit: 10, input: { kind: "start", objectTypeId: "Room" } },
    expansions: [{ linkId: "hasDevice", direction: "outgoing", cardinality: "many", limit: 50 }],
  })

  // Output-shaping: the input row set rides through under `_expand`.
  expect(compiled.sql).toContain("SELECT input.*,")
  expect(compiled.sql).toContain("AS _expand")
  // Top-N per parent pushed into the DB, then aggregated in rank order.
  expect(compiled.sql).toContain("row_number() OVER (ORDER BY")
  expect(compiled.sql).toContain("json_group_array(json(ranked_0.elem) ORDER BY ranked_0._ord)")
  expect(compiled.sql).toContain("WHERE ranked_0._ord <= ?")
  expect(compiled.sql).toContain("'[]'")
  // Outgoing: parent on the link source, neighbour hydrated from the target.
  expect(compiled.sql).toContain("edge_0.source_type_id = input.object_type_id")
  expect(compiled.sql).toContain("tgt_0.object_type_id = edge_0.target_type_id")
  expect(compiled.sql).toContain("'linkProperties', json(edge_0.properties)")
  // Link id rides as a param twice (the json key and the edge filter); then the
  // baked fanout, then the input's own params.
  expect(compiled.args).toEqual(["hasDevice", "hasDevice", 50, "project-a", "Room", 10])
})

test("expand SQL takes the first ranked element for a one link", () => {
  const compiled = compileObjectQuery("project-a", {
    kind: "expand",
    input: { kind: "limit", limit: 5, input: { kind: "start", objectTypeId: "User" } },
    expansions: [{ linkId: "manager", direction: "outgoing", cardinality: "one", limit: 1000 }],
  })

  expect(compiled.sql).toContain("WHERE ranked_0._ord = 1")
  expect(compiled.sql).not.toContain("json_group_array")
  expect(compiled.sql).not.toContain("_ord <=")
  // No fanout param for a "one" link — it always takes a single element.
  expect(compiled.args).toEqual(["manager", "manager", "project-a", "User", 5])
})

test("expand SQL flips parent/neighbour columns and filters source type for incoming", () => {
  const compiled = compileObjectQuery("project-a", {
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
  expect(compiled.sql).toContain("edge_0.source_type_id = ?")
  expect(compiled.args).toEqual(["hasDevice", "hasDevice", "Room", 1000, "project-a", "Device", 5])
})

test("expand SQL orders a bounded many link by target properties, nulls last", () => {
  const compiled = compileObjectQuery("project-a", {
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
  // against the neighbour's JSON properties — mirroring the fallback comparator.
  expect(compiled.sql).toContain("json_type(tgt_0.properties, ?)")
  expect(compiled.sql).toContain("json_extract(tgt_0.properties, ?) DESC")
  expect(compiled.args).toEqual([
    "hasDevice",
    '$."name"',
    '$."name"',
    '$."name"',
    "hasDevice",
    5,
    "project-a",
    "Room",
    10,
  ])
})

test("expand SQL nests a child expansion correlated on the parent neighbour", () => {
  const compiled = compileObjectQuery("project-a", {
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
  expect(compiled.sql).toContain("'links', json_object(")
  expect(compiled.sql).toContain("edge_0_0.source_id = tgt_0.primary_id")
  expect(compiled.sql).toContain("json_group_array(json(ranked_0_0.elem)")
})

const expandableQuery: ObjectQuery = {
  kind: "expand",
  input: { kind: "start", objectTypeId: "Room" },
  expansions: [{ linkId: "hasDevice", direction: "outgoing", cardinality: "many", limit: 50 }],
}

test("vector remains an unsupported query node", () => {
  expect(() =>
    compileObjectQuery("project-a", { kind: "vector" } as unknown as ObjectQuery)
  ).toThrow("does not support query node 'vector'")
  // expand is now supported and compiles without throwing.
  expect(() => compileObjectQuery("project-a", expandableQuery)).not.toThrow()
})

test("rejects direct exact decimal pushdown instead of using lossy SQLite comparisons", () => {
  expect(() =>
    compileObjectQuery("project-a", {
      kind: "filter",
      predicate: {
        op: "eq",
        propertyId: "amount",
        value: "9007199254740993",
        scalarKind: "decimal",
      },
      input: { kind: "start", objectTypeId: "Balance" },
    })
  ).not.toThrow()

  expect(() =>
    compileObjectQuery("project-a", {
      kind: "filter",
      predicate: {
        op: "gt",
        propertyId: "amount",
        value: "9007199254740993",
        scalarKind: "decimal",
      },
      input: { kind: "start", objectTypeId: "Balance" },
    })
  ).toThrow("cannot push down exact decimal predicates")

  expect(() =>
    compileObjectQuery("project-a", {
      kind: "sort",
      fields: [{ kind: "property", propertyId: "amount", scalarKind: "decimal" }],
      input: { kind: "start", objectTypeId: "Balance" },
    })
  ).toThrow("cannot push down exact decimal sorting")

  expect(() =>
    compileObjectQuery("project-a", {
      kind: "expand",
      input: { kind: "start", objectTypeId: "Account" },
      expansions: [
        {
          linkId: "balances",
          direction: "outgoing",
          cardinality: "many",
          orderBy: [{ kind: "property", propertyId: "amount", scalarKind: "decimal" }],
        },
      ],
    })
  ).toThrow("cannot push down exact decimal expansion sorting")
})
