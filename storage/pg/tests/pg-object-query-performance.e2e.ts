import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ObjectQuery } from "@sixb/core"
import type { PostgresStorage } from "../src"
import { compilePgObjectCountQuery, compilePgObjectQuery } from "../src/objects/query-compiler"
import { findPgSortIndexBound } from "../src/objects/query-indexes"
import { createPgClient, type SQL, type SqlParameter } from "../src/pg-client"
import { createTestStorage } from "./helpers"

let storage: PostgresStorage
let sql: SQL
const start: ObjectQuery = { kind: "start", objectTypeId: "User" }
const recent: ObjectQuery = {
  kind: "sort",
  input: start,
  fields: [{ kind: "property", propertyId: "createdAt", direction: "desc" }],
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
  await sql`INSERT INTO objects
    SELECT 'bench', 'User', lpad(n::text, 5, '0'),
      jsonb_build_object('createdAt', n, 'status', CASE WHEN n % 10 = 0 THEN 'archived' ELSE 'active' END,
        'text', CASE WHEN n = 123 THEN 'Literal%_' || chr(92) || 'Needle' ELSE 'ordinary profile ' || n END),
      now(), now(), 1, 'seed'
    FROM generate_series(1, 5000) n`
  await sql`INSERT INTO objects
    SELECT 'bench', 'Small', lpad(n::text, 3, '0'),
      CASE WHEN n % 7 = 0 THEN '{}'::jsonb ELSE jsonb_build_object('a', CASE WHEN n % 5 = 0 THEN NULL ELSE (n % 4)::text END) END
        || jsonb_build_object('b', n % 3), now(), now(), 1, 'seed'
    FROM generate_series(1, 80) n`
  await sql`INSERT INTO links
    SELECT 'bench', 'User', lpad(n::text, 5, '0'), 'group', 'Small', '001', NULL, now(), now(), 'seed'
    FROM generate_series(1, 5000) n`
  await storage.ensureObjectQueryIndexes([
    { projectId: "bench", objectTypeId: "Small", kind: "incomingLinks" },
    {
      projectId: "bench",
      objectTypeId: "User",
      kind: "sort",
      fields: [{ propertyId: "createdAt", direction: "desc" }],
    },
    { projectId: "bench", objectTypeId: "User", kind: "text", propertyId: "text" },
    { projectId: "bench", objectTypeId: "User", kind: "count", where: { status: "active" } },
  ])
  await sql.unsafe("VACUUM (ANALYZE) objects")
  await sql.unsafe("VACUUM (ANALYZE) links")
}, 30_000)

afterAll(async () => {
  await sql?.end()
  await storage?.dropSchema()
  await storage?.close()
})

async function explain(query: ObjectQuery) {
  const compiled = compilePgObjectQuery("bench", query, {
    includeTotal: false,
    sortIndexBound: await findPgSortIndexBound(sql, "bench", query),
  })
  const rows = await sql.unsafe(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${compiled.sql}`,
    compiled.args as SqlParameter[]
  )
  return rows[0]?.["QUERY PLAN"][0]
}

function visitedRows(plan: {
  "Actual Rows"?: number
  "Actual Loops"?: number
  "Rows Removed by Filter"?: number
  Plans?: Parameters<typeof visitedRows>[0][]
}): number {
  return (
    ((plan["Actual Rows"] ?? 0) + (plan["Rows Removed by Filter"] ?? 0)) *
      (plan["Actual Loops"] ?? 0) +
    (plan.Plans ?? []).reduce((sum, child) => sum + visitedRows(child), 0)
  )
}

function groupedLookupLoops(plan: {
  "Index Cond"?: string
  "Actual Loops"?: number
  Plans?: Parameters<typeof groupedLookupLoops>[0][]
}): number {
  if (plan["Index Cond"]?.includes("ANY (")) return plan["Actual Loops"] ?? Infinity
  return Math.min(...(plan.Plans ?? []).map(groupedLookupLoops))
}

// Guard removal: restore query-compiler.ts from the PR #706 base. Both plan bounds fail
// on PostgreSQL 17 (full nested sort / cursor filtering instead of bounded index ranges).
test("first and deep pages read bounded index ranges", async () => {
  const first: ObjectQuery = { kind: "page", input: recent, pageSize: 40 }
  const firstPlan = await explain(first)
  expect(visitedRows(firstPlan.Plan)).toBeLessThan(500)
  expect(JSON.stringify(firstPlan)).toContain("sixb_query_")

  const anchor = compilePgObjectQuery("bench", first, { includeTotal: false })
  const token = anchor.nextPageToken(
    [{ object_type_id: "User", primary_id: "00500", properties: { createdAt: 500 } }],
    41
  )
  const deep: ObjectQuery = { ...first, pageToken: token }
  const deepPlan = await explain(deep)
  expect(visitedRows(deepPlan.Plan)).toBeLessThan(1000)
  const result = await storage.objects.queryObjects!({
    projectId: "bench",
    query: deep,
    includeTotal: false,
  })
  expect(result.objects[0]?.primaryId).toBe("00499")
  expect(result.objects).toHaveLength(40)
})

test("a high-fanout traversal pages through indexed endpoints and preserves totals", async () => {
  const traversed: ObjectQuery = {
    kind: "traverse",
    direction: "incoming",
    sourceObjectTypeId: "User",
    linkId: "group",
    input: { kind: "refs", refs: [{ objectTypeId: "Small", primaryId: "001" }] },
  }
  const query: ObjectQuery = { kind: "page", pageSize: 40, input: { ...recent, input: traversed } }
  const compiled = compilePgObjectQuery("bench", query, {
    includeTotal: false,
    sortIndexBound: await findPgSortIndexBound(sql, "bench", query),
  })
  expect(compiled.traversalProbe?.limit).toBe(1000)
  const probe = compiled.traversalProbe!
  expect(await sql.unsafe(probe.sql, probe.args as SqlParameter[])).toHaveLength(1001)
  const result = await storage.objects.queryObjects!({
    projectId: "bench",
    query,
    includeTotal: false,
  })
  expect(result.objects).toHaveLength(40)
  expect(result.objects[0]?.primaryId).toBe("05000")
  expect(result.nextPageToken).toBeDefined()
  const next = await storage.objects.queryObjects!({
    projectId: "bench",
    query: { ...query, pageToken: result.nextPageToken },
    includeTotal: false,
  })
  expect(next.objects[0]?.primaryId).toBe("04960")
  const full = await storage.objects.countObjects!({ projectId: "bench", query: traversed })
  expect(full.count).toBe(5000)
  const correlated = compilePgObjectQuery("bench", query, {
    includeTotal: false,
    correlatedTraversal: true,
    sortIndexBound: await findPgSortIndexBound(sql, "bench", query),
  })
  const rows = await sql.unsafe(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${correlated.sql}`,
    correlated.args as SqlParameter[]
  )
  expect(visitedRows(rows[0]?.["QUERY PLAN"][0].Plan)).toBeLessThan(1000)
  expect(correlated.totalSql).not.toContain("OFFSET 0")
  const withTotal = await storage.objects.queryObjects!({ projectId: "bench", query })
  expect(withTotal.total).toBe(5000)
  expect(withTotal.objects.map((row) => row.primaryId)).toEqual(
    result.objects.map((row) => row.primaryId)
  )
  const aggregate = compilePgObjectCountQuery("bench", traversed)
  const totalPlan = await sql.unsafe(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${aggregate.sql}`,
    aggregate.args as SqlParameter[]
  )
  expect(JSON.stringify(totalPlan)).toContain("Index Only Scan")
  // Removing incoming aggregate batching removes the grouped primary-key lookup on PG17.
  expect(groupedLookupLoops(totalPlan[0]?.["QUERY PLAN"][0].Plan)).toBeLessThan(100)
})

// Guard removal: restore compileTextPredicate's position() expression. This plan loses
// its trigram bitmap index scan; the literal matching assertions also guard LIKE escaping.
test("substring search uses trigrams and treats wildcard characters literally", async () => {
  const query: ObjectQuery = { kind: "text", input: start, query: "AL%_\\NEE", fields: ["text"] }
  const plan = await explain(query)
  expect(JSON.stringify(plan)).toContain("Bitmap Index Scan")
  const result = await storage.objects.queryObjects!({
    projectId: "bench",
    query,
    includeTotal: false,
  })
  expect(result.objects.map((row) => row.primaryId)).toEqual(["00123"])
})

test("cursor ranges preserve mixed directions, ties, missing and explicit null values", async () => {
  for (const direction of ["asc", "desc"] as const) {
    const sorted: ObjectQuery = {
      kind: "sort",
      input: { kind: "start", objectTypeId: "Small" },
      fields: [
        { kind: "property", propertyId: "a", direction },
        { kind: "property", propertyId: "b", direction: direction === "asc" ? "desc" : "asc" },
      ],
    }
    const expected = await storage.objects.queryObjects!({
      projectId: "bench",
      query: sorted,
      includeTotal: false,
    })
    const ids: string[] = []
    let pageToken: string | undefined
    for (let i = 0; i < 20; i++) {
      const page = await storage.objects.queryObjects!({
        projectId: "bench",
        query: { kind: "page", input: sorted, pageSize: 7, pageToken },
        includeTotal: false,
      })
      ids.push(...page.objects.map((row) => row.primaryId))
      pageToken = page.nextPageToken
      if (!page.hasMore) break
    }
    expect(ids).toEqual(expected.objects.map((row) => row.primaryId))
    expect(new Set(ids).size).toBe(80)
  }
})

test("partial count indexes remain exact after writes and are idempotent", async () => {
  const definition = {
    projectId: "bench",
    objectTypeId: "User",
    kind: "count",
    where: { status: "active" },
  } as const
  const names = await storage.ensureObjectQueryIndexes([definition])
  expect(await storage.ensureObjectQueryIndexes([definition])).toEqual(names)
  const query: ObjectQuery = {
    kind: "filter",
    input: start,
    predicate: { op: "in", propertyId: "status", values: ["active"] },
  }
  const compiled = compilePgObjectCountQuery("bench", query)
  const plan = await sql.unsafe(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${compiled.sql}`,
    compiled.args as SqlParameter[]
  )
  expect(JSON.stringify(plan)).toContain("Index Only Scan")
  expect((await storage.objects.countObjects!({ projectId: "bench", query })).count).toBe(4500)
  await sql`UPDATE objects SET properties = jsonb_set(properties, '{status}', '"archived"') WHERE project_id = 'bench' AND object_type_id = 'User' AND primary_id = '00001'`
  expect((await storage.objects.countObjects!({ projectId: "bench", query })).count).toBe(4499)
  await sql`DELETE FROM objects WHERE project_id = 'bench' AND object_type_id = 'User' AND primary_id = '00002'`
  expect((await storage.objects.countObjects!({ projectId: "bench", query })).count).toBe(4498)
})

test("index definitions safely quote identifiers and reject invalid inputs before DDL", async () => {
  const names = await storage.ensureObjectQueryIndexes([
    {
      projectId: "p'\\?",
      objectTypeId: "t'",
      kind: "sort",
      fields: [{ propertyId: "x'); DROP TABLE objects; --" }],
    },
  ])
  expect(names).toHaveLength(1)
  expect((await sql`SELECT count(*) AS count FROM objects`)[0]?.count).toBe("5079")
  await expect(
    storage.ensureObjectQueryIndexes([
      { projectId: "bench", objectTypeId: "User", kind: "sort", fields: [] },
    ])
  ).rejects.toThrow("one and eight")
  await expect(
    storage.transaction(async () => storage.ensureObjectQueryIndexes([]))
  ).rejects.toThrow()
})
