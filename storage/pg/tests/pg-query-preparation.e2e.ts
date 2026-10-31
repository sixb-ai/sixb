import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  defineObjectType,
  link,
  type ObjectQuery,
  OntologyRegistry,
  prepareObjectQueries,
  prop,
} from "@sixb/core"
import { createMaterializerTestFixture } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { compilePgObjectQuery } from "../src/objects/query-compiler"
import { findPgSortIndexBound, PgSortIndexCatalog } from "../src/objects/query-indexes"
import { createPgClient, type SQL, type SqlParameter } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

const Author = defineObjectType({
  id: "Author",
  name: "Author",
  properties: [prop("id", "string", { primary: true, required: true })],
})

const Article = defineObjectType({
  id: "Article",
  name: "Article",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("title", "string", {
      nullable: true,
      query: { searchable: true, sortable: true, text: true },
    }),
    prop("state", "string", {
      nullable: true,
      query: { searchable: true, filterable: true, facet: true, sortable: true },
    }),
  ],
  links: [link("author", Author, { cardinality: "one" })],
  query: {
    indexes: [
      {
        kind: "sort",
        fields: [
          { propertyId: "title", direction: "asc" },
          { propertyId: "state", direction: "desc" },
        ],
      },
      { kind: "text", propertyId: "title", filters: ["state"] },
    ],
  },
})
const ontology = new OntologyRegistry({ sources: [Author, Article] })
let storage: PostgresStorage
let sql: SQL
// One fixture: its commits are numbered, and a second would reuse the first one's idempotency keys.
let fixture: ReturnType<typeof createMaterializerTestFixture>
beforeAll(async () => {
  const created = await createTestStorage()
  storage = created.storage
  sql = createPgClient({
    connectionString: created.connectionString,
    schemaName: created.schemaName,
    max: 2,
  })
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public")
  fixture = createMaterializerTestFixture({ projectId: "publication", ontology, storage })
  const result = await prepareObjectQueries({ projectId: "publication", ontology, storage })
  expect(result.objectTypes).toBe(2)
  expect(result.indexes).toBeGreaterThan(0)
})
afterAll(async () => {
  await sql?.end()
  if (storage) await disposeTestStorage(storage)
})

// Guard removal: omit the sort entry-size predicate from query-indexes.ts: the
// materializer insertion of the incompressible long value fails with a B-tree size error.
// Omit the overflow page from query-compiler.ts: pagination silently loses that object.
test("ontology preparation supports another project's materializer, long values, pages and facets", async () => {
  const long = Array.from({ length: 300 }, (_, i) => Bun.hash(`word-${i}`).toString(16)).join("")
  await fixture.seed({
    objects: [
      {
        ref: { objectTypeId: "Article", primaryId: "a" },
        properties: { id: "a", title: "alpha", state: "draft" },
      },
      {
        ref: { objectTypeId: "Article", primaryId: "b" },
        properties: { id: "b", title: long, state: long },
      },
      {
        ref: { objectTypeId: "Article", primaryId: "c" },
        properties: { id: "c", title: "omega", state: "published" },
      },
      {
        ref: { objectTypeId: "Article", primaryId: "d" },
        properties: { id: "d", title: null, state: null },
      },
    ],
  })
  const base: ObjectQuery = { kind: "start", objectTypeId: "Article" }
  const sorted: ObjectQuery = {
    kind: "sort",
    input: base,
    fields: [
      { kind: "property", propertyId: "title", direction: "asc", scalarKind: "string" },
      { kind: "property", propertyId: "state", direction: "desc", scalarKind: "string" },
    ],
  }
  const original = compilePgObjectQuery("publication", sorted, { includeTotal: false })
  const expected = await sql.unsafe(original.sql, original.args as SqlParameter[])
  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const result = await storage.objects.queryObjects!({
      projectId: "publication",
      query: { kind: "page", input: sorted, pageSize: 1, pageToken },
      includeTotal: false,
    })
    ids.push(...result.objects.map((row) => row.primaryId))
    pageToken = result.nextPageToken
  } while (pageToken)
  expect(ids).toEqual(expected.map((row) => row.primary_id))
  expect(ids).toHaveLength(4)
  const facets = await storage.objects.facetObjects!({
    projectId: "publication",
    query: base,
    facets: [{ propertyId: "state", limit: 2 }],
  })
  expect(facets.total).toBe(4)
  expect(facets.facets[0]!.buckets).toHaveLength(2)
  const exact = await storage.objects.countObjects!({
    projectId: "publication",
    query: {
      kind: "filter",
      input: base,
      predicate: { op: "eq", propertyId: "state", value: long },
    },
  })
  expect(exact.count).toBe(1)
  const again = await prepareObjectQueries({ projectId: "publication", ontology, storage })
  expect(again.objectTypes).toBe(2)
  expect(
    (await storage.objects.countObjects!({ projectId: "publication", query: base })).count
  ).toBe(4)
})

// Guard removal: compare candidate.direction to fields[i].direction without applying
// the default. Fluent .orderBy(property) then misses its prepared index.
test("implicit ascending sorts discover their prepared bounded index", async () => {
  const query: ObjectQuery = {
    kind: "page",
    pageSize: 40,
    input: {
      kind: "sort",
      input: { kind: "start", objectTypeId: "Article" },
      fields: [{ kind: "property", propertyId: "title", scalarKind: "string" }],
    },
  }
  expect(await findPgSortIndexBound(sql, new PgSortIndexCatalog(), "publication", query)).toContain(
    "octet_length"
  )
})

// The bounded read merges an indexed and an overflow branch (the long title), then expands the
// merged page once. Guard removal: skip that expansion in compilePgObjectQuery and every Article
// comes back without its Author.
test("a prepared sorted page expands links of indexed and overflow rows alike", async () => {
  const long = Array.from({ length: 300 }, (_, i) => Bun.hash(`title-${i}`).toString(16)).join("")
  const author = (articleId: string, authorId: string) => ({
    ref: {
      source: { objectTypeId: "Article", primaryId: articleId },
      linkId: "author",
      target: { objectTypeId: "Author", primaryId: authorId },
    },
  })
  await fixture.seed({
    objects: [
      { ref: { objectTypeId: "Author", primaryId: "ann" }, properties: { id: "ann" } },
      { ref: { objectTypeId: "Author", primaryId: "bo" }, properties: { id: "bo" } },
      {
        ref: { objectTypeId: "Article", primaryId: "short" },
        properties: { id: "short", title: "beta", state: "draft" },
      },
      {
        ref: { objectTypeId: "Article", primaryId: "long" },
        properties: { id: "long", title: long, state: "draft" },
      },
    ],
    links: [author("short", "ann"), author("long", "bo")],
  })
  const page: ObjectQuery = {
    kind: "page",
    pageSize: 20,
    input: {
      kind: "sort",
      input: { kind: "start", objectTypeId: "Article" },
      fields: [
        { kind: "property", propertyId: "title", direction: "asc", scalarKind: "string" },
        { kind: "property", propertyId: "state", direction: "desc", scalarKind: "string" },
      ],
    },
  }
  const expanded: ObjectQuery = {
    kind: "expand",
    input: page,
    expansions: [{ linkId: "author", direction: "outgoing", cardinality: "one", limit: 1 }],
  }
  expect(
    await findPgSortIndexBound(sql, new PgSortIndexCatalog(), "publication", expanded)
  ).toContain("octet_length")

  const plain = await storage.objects.queryObjects!({ projectId: "publication", query: page })
  const result = await storage.objects.queryObjects!({ projectId: "publication", query: expanded })
  expect(result.objects.map((row) => row.primaryId)).toEqual(
    plain.objects.map((row) => row.primaryId)
  )
  const authors = new Map(
    result.objects.map((row) => {
      const author = row.links?.author
      return [row.primaryId, author && "primaryId" in author ? author.primaryId : null]
    })
  )
  expect(authors.get("short")).toBe("ann")
  expect(authors.get("long")).toBe("bo")
})
