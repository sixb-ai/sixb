import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { defineObjectType, type ObjectQuery, OntologyRegistry, prop } from "@sixb/core"
import { compileSelectedObjectReadScope } from "@sixb/core/storage"
import { createMaterializerTestFixture } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import {
  compilePgObjectCountQuery,
  DEFAULT_OBJECT_QUERY_SOURCE,
} from "../src/objects/query-compiler"
import { compilePgSelectedObjectReadSource } from "../src/objects/read-scope"
import { PgObjectReader } from "../src/objects/reader"
import { compilePgIndexedTextCount } from "../src/objects/text-count-index"
import { createPgClient, type SQL, type SqlParameter } from "../src/pg-client"
import { createTestStorage } from "./helpers"

let storage: PostgresStorage
let sql: SQL
const start: ObjectQuery = { kind: "start", objectTypeId: "User" }
const text: ObjectQuery = { kind: "text", input: start, fields: ["searchText"], query: "alpha" }
const definition = {
  projectId: "p",
  objectTypeId: "User",
  propertyId: "searchText",
  filters: ["status"],
}

beforeAll(async () => {
  const created = await createTestStorage()
  storage = created.storage
  sql = createPgClient({
    connectionString: process.env.DATABASE_URL,
    schemaName: created.schemaName,
    max: 2,
  })
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public")
  await sql`INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id)
    SELECT 'p','User',n::text,jsonb_build_object('searchText','Alpha %_' || chr(92) || ' literal ' || n,'status',(n%3)::text,'padding',repeat(md5(n::text),50)),now(),now(),1,'seed' FROM generate_series(1,5000) n`
  await sql`INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id)
    VALUES ('other','User','1','{"searchText":"alpha","status":"1"}',now(),now(),1,'seed')`
  await storage.prepareObjectTextCounts([definition])
  await sql.unsafe("VACUUM (ANALYZE) objects")
}, 30_000)

afterAll(async () => {
  await sql?.end()
  await storage?.dropSchema()
  await storage?.close()
})

async function normalCount(query: ObjectQuery): Promise<number> {
  const compiled = compilePgObjectCountQuery("p", query)
  const rows = await sql.unsafe(compiled.sql, compiled.args as SqlParameter[])
  return Number(rows[0]?.count)
}
async function compare(query: ObjectQuery) {
  const expected = await normalCount(query)
  expect((await storage.objects.countObjects!({ projectId: "p", query })).count).toBe(expected)
  return expected
}

// Guard removal: remove compilePgIndexedTextCount's use in PgObjectReader.countObjects and
// the observed production SQL assertion fails; removing index preparation makes
// indexed compilation unavailable. Long-value tests fail if the overflow arm is removed.
test("common terms count through a covering index and equal the JSON predicate", async () => {
  const compiled = await compilePgIndexedTextCount(sql, "p", text)
  expect(compiled).toBeDefined()
  const plan = await sql.unsafe(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${compiled!.sql}`,
    compiled!.args as SqlParameter[]
  )
  expect(JSON.stringify(plan)).toContain("Index Only Scan")
  const observed = spyOn(sql, "unsafe")
  try {
    await new PgObjectReader(sql, DEFAULT_OBJECT_QUERY_SOURCE).countObjects({
      projectId: "p",
      query: text,
    })
    expect(observed.mock.calls.some(([statement]) => statement.includes("sixb_qtext_"))).toBe(true)
  } finally {
    observed.mockRestore()
  }
  expect(await compare(text)).toBe(5000)
  const page = await storage.objects.queryObjects!({
    projectId: "p",
    query: { kind: "page", pageSize: 5, input: text },
  })
  expect(page.total).toBe(5000)
  expect(page.objects).toHaveLength(5)
  const bounded = await storage.objects.queryObjects!({
    projectId: "p",
    query: { kind: "page", pageSize: 5, input: { kind: "limit", limit: 7, input: text } },
  })
  expect(bounded.total).toBe(7)
  await compare({
    kind: "filter",
    input: text,
    predicate: { op: "in", propertyId: "status", values: ["1", "2"] },
  })
  await compare({ kind: "text", input: start, fields: ["searchText"], query: "%_\\ literal" })
  expect(await compilePgIndexedTextCount(sql, "other", text)).toBeUndefined()
})

test("long text and long filter values remain writable and exactly counted", async () => {
  for (const [id, searchText, status] of [
    ["long-text", `alpha ${"界".repeat(1500)}`, "1"],
    ["long-filter", "alpha", "x".repeat(2000)],
    ["null-status", "alpha", null],
    ["numeric-status", "alpha", 1],
  ])
    await sql`INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id) VALUES ('p','User',${id},${sql.json({ searchText, status })},now(),now(),1,'seed')`
  expect(await compare(text)).toBe(5004)
  expect(
    await compare({
      kind: "filter",
      input: text,
      predicate: { op: "eq", propertyId: "status", value: "x".repeat(2000) },
    })
  ).toBe(1)
  await compare({
    kind: "filter",
    input: text,
    predicate: { op: "eq", propertyId: "status", value: "1" },
  })
  const nullable: ObjectQuery = {
    kind: "filter",
    input: text,
    predicate: { op: "eq", propertyId: "status", value: null },
  }
  expect(await compilePgIndexedTextCount(sql, "p", nullable)).toBeUndefined()
  expect(await compare(nullable)).toBe(1)
  await compare({
    kind: "filter",
    input: text,
    predicate: { op: "not", item: { op: "eq", propertyId: "status", value: "1" } },
  })
  await compare({
    kind: "filter",
    input: text,
    predicate: { op: "eq", propertyId: "status", value: 1 },
  })
})

test("generated values follow updates and rollbacks without cache staleness", async () => {
  await sql
    .begin(async (tx) => {
      await tx`UPDATE objects SET properties=jsonb_set(properties,'{searchText}','"beta"') WHERE project_id='p' AND primary_id='1'`
      const compiled = await compilePgIndexedTextCount(tx, "p", text)
      const [row] = await tx.unsafe(compiled!.sql, compiled!.args as SqlParameter[])
      expect(Number(row?.count)).toBe(5003)
      throw new Error("rollback fixture")
    })
    .catch((error) => {
      expect(error.message).toBe("rollback fixture")
    })
  expect(await compare(text)).toBe(5004)
  await sql`UPDATE objects SET properties=jsonb_set(properties,'{searchText}','"beta"') WHERE project_id='p' AND primary_id='1'`
  expect(await compare(text)).toBe(5003)
  await sql`DELETE FROM objects WHERE project_id='p' AND primary_id='long-text'`
  expect(await compare(text)).toBe(5002)
})

test("preparation is idempotent and disallowed inside application transactions", async () => {
  const first = await storage.prepareObjectTextCounts([definition])
  expect(await storage.prepareObjectTextCounts([definition])).toEqual(first)
  await expect(
    storage.transaction(async () => storage.prepareObjectTextCounts([definition]))
  ).rejects.toThrow()
})

test("prepared text counts cannot bypass selected object or property grants", async () => {
  for (const properties of [["status"], ["searchText", "status"]]) {
    const scope = compileSelectedObjectReadScope({
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: "User", primaryId: "2" },
          node: { objects: [{ objectTypeId: "User", propertyIds: properties }], links: [] },
        },
      ],
    })
    const reader = new PgObjectReader(sql, compilePgSelectedObjectReadSource("p", scope, 100))
    expect((await reader.countObjects({ projectId: "p", query: text })).count).toBe(
      properties.includes("searchText") ? 1 : 0
    )
  }
})

test("ontology materialization writes remain compatible with generated columns", async () => {
  const User = defineObjectType({
    id: "User",
    name: "User",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      prop("searchText", "string"),
      prop("status", "string"),
    ],
  })
  const fixture = createMaterializerTestFixture({
    projectId: "p",
    ontology: new OntologyRegistry({ sources: [User] }),
    storage,
  })
  await fixture.seed({
    objects: [
      {
        ref: { objectTypeId: "User", primaryId: "materialized" },
        properties: { id: "materialized", searchText: "alpha materialized", status: "1" },
      },
    ],
  })
  expect(await compare(text)).toBe(5003)
})

test("a filter after projection retains the projected property visibility in list totals", async () => {
  const query: ObjectQuery = {
    kind: "text",
    fields: ["searchText"],
    query: "alpha",
    input: { kind: "project", input: start, properties: ["status"] },
  }
  expect(await compilePgIndexedTextCount(sql, "p", query)).toBeUndefined()
  const page = await storage.objects.queryObjects!({
    projectId: "p",
    query: { kind: "page", pageSize: 10, input: query },
  })
  expect(page.total).toBe(0)
  expect(page.objects).toHaveLength(0)
})

// Guard removal: bypass compilePgIndexedTextFacets in PgObjectReader; the observed SQL
// assertion fails. Omitting the overflow arm loses missing/null/long values below.
test("facets share one exact total and preserve null, missing, overflow and bucket limits", async () => {
  const extras = [
    { id: "facet-missing", searchText: "alpha" },
    { id: "facet-null", searchText: "alpha", status: null },
    { id: "facet-long", searchText: `alpha ${"x".repeat(2000)}`, status: "wide".repeat(80) },
    { id: "facet-number", searchText: "alpha", status: 7 },
  ]
  for (const value of extras)
    await sql`INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id)
      VALUES ('p','User',${value.id},${sql.json(value)},now(),now(),1,'facet-test')`
  try {
    const { compilePgObjectFacetsQuery } = await import("../src/objects/query-compiler")
    const { compilePgIndexedTextFacets } = await import("../src/objects/text-count-index")
    for (const query of [
      start,
      text,
      { ...text, query: "literal 1234" },
      { ...text, query: "no such match" },
    ] as ObjectQuery[]) {
      const facets = [{ propertyId: "status", limit: 2 }]
      const generic = compilePgObjectFacetsQuery("p", query, facets)
      const indexed = await compilePgIndexedTextFacets(sql, "p", query, facets)
      expect(indexed).toBeDefined()
      const baseline = await sql.unsafe(generic.sql, generic.args as SqlParameter[])
      const optimized = await sql.unsafe(indexed!.sql, indexed!.args as SqlParameter[])
      expect(optimized).toEqual(baseline)
      const result = await storage.objects.facetObjects!({ projectId: "p", query, facets })
      expect(result.total).toBe(await normalCount(query))
      expect(result.facets[0]!.buckets.length).toBeLessThanOrEqual(2)
    }
    const observed = spyOn(sql, "unsafe")
    try {
      await new PgObjectReader(sql, DEFAULT_OBJECT_QUERY_SOURCE).facetObjects({
        projectId: "p",
        query: text,
        facets: [{ propertyId: "status", limit: 10 }],
      })
      expect(
        observed.mock.calls.some(([statement]) => statement.includes("_sixb_native_facets"))
      ).toBe(true)
    } finally {
      observed.mockRestore()
    }
  } finally {
    await sql`DELETE FROM objects WHERE project_id='p' AND primary_id IN ${sql(extras.map((row) => row.id))}`
  }
})
