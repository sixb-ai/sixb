import { expect, test } from "bun:test"
import { compileObjectQuery } from "../src/objects/query-compiler"

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

test("rejects vector queries without a validated named profile", () => {
  expect(() =>
    compileObjectQuery("project-a", {
      kind: "vector",
      input: { kind: "start", objectTypeId: "Room" },
      profile: "content",
      vector: [1, 0],
      k: 1,
    })
  ).toThrow("A validated named vector profile is required.")
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
