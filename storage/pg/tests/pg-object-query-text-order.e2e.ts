import { afterAll, beforeAll, expect, test } from "bun:test"
import type { ObjectQuery } from "@sixb/core"
import type { PostgresStorage } from "../src"
import { compilePgObjectQuery } from "../src/objects/query-compiler"
import {
  findPgSortIndexBound,
  type PgObjectQueryIndex,
  PgSortIndexCatalog,
} from "../src/objects/query-indexes"
import { createPgClient, type SQL, type SqlParameter } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

// Strings sort by code point (`COLLATE "C"`), whatever the database collation. These cases cover
// what the shared contract cannot see: the sort index carries that collation, so sorted pages and
// string ranges stay index ranges, and an index from before the change is replaced, not kept.
// Guard removal: restore query-indexes.ts from main. The sort index is then built over JSONB, the
// plans below sort and filter every row, and the earlier generation survives.

let storage: PostgresStorage
let sql: SQL

const start: ObjectQuery = { kind: "start", objectTypeId: "Label" }
const byCode = (input: ObjectQuery): ObjectQuery => ({
  kind: "sort",
  fields: [{ kind: "property", propertyId: "code", direction: "asc", scalarKind: "string" }],
  input,
})
const definition: PgObjectQueryIndex = {
  projectId: "bench",
  objectTypeId: "Label",
  kind: "sort",
  fields: [{ propertyId: "code", scalarKind: "string" }],
}

beforeAll(async () => {
  const created = await createTestStorage()
  storage = created.storage
  sql = createPgClient({
    connectionString: created.connectionString,
    schemaName: created.schemaName,
    max: 2,
  })

  // Leading characters on which linguistic and code-point order disagree.
  await sql`INSERT INTO objects
    SELECT 'bench', 'Label', lpad(n::text, 5, '0'),
      jsonb_build_object('code', (ARRAY['a', 'A', 'b', 'B', 'é', 'É', 'z', 'Z'])[1 + n % 8] || lpad(n::text, 5, '0')),
      now(), now(), 1, 'seed'
    FROM generate_series(1, 4000) n`

  // The previous generation of the same index: identical definition, JSONB expression.
  const code = "properties -> 'code'"
  await sql.unsafe(`CREATE INDEX sixb_query_previous ON objects_default (
      (CASE WHEN jsonb_typeof(${code}) IS NULL OR jsonb_typeof(${code}) = 'null' THEN 1 ELSE 0 END),
      (NULLIF(${code}, 'null'::jsonb)) ASC, primary_id
    ) WHERE project_id = 'bench' AND object_type_id = 'Label'`)
  await sql.unsafe("CREATE INDEX sixb_query_previous_overflow ON objects_default (primary_id)")
  await sql.unsafe(
    `COMMENT ON INDEX sixb_query_previous IS '${JSON.stringify(definition).replaceAll("'", "''")}'`
  )

  await storage.ensureObjectQueryIndexes([definition])
  await sql.unsafe("VACUUM (ANALYZE) objects")
}, 30_000)

afterAll(async () => {
  await sql?.end()
  if (storage) await disposeTestStorage(storage)
})

async function explain(query: ObjectQuery) {
  const compiled = compilePgObjectQuery("bench", query, {
    includeTotal: false,
    sortIndexBound: await findPgSortIndexBound(sql, new PgSortIndexCatalog(), "bench", query),
  })
  const rows = await sql.unsafe(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${compiled.sql}`,
    compiled.args as SqlParameter[]
  )
  return JSON.stringify(rows[0]?.["QUERY PLAN"][0])
}

function removedByFilter(plan: string): number {
  return [...plan.matchAll(/"Rows Removed by Filter":(\d+)/g)].reduce(
    (sum, match) => sum + Number(match[1]),
    0
  )
}

test("replaces an earlier generation of a sort index", async () => {
  const indexes = await sql<{ name: string }[]>`
    SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'objects'::regclass)
      AND c.relname LIKE 'sixb_query_%'
    ORDER BY c.relname`
  const names = indexes.map((index) => index.name)

  expect(names).not.toContain("sixb_query_previous")
  expect(names).not.toContain("sixb_query_previous_overflow")
  expect(names).toHaveLength(2)
})

test("sorted pages and string ranges read the collated sort index", async () => {
  const page = await explain({ kind: "page", pageSize: 20, input: byCode(start) })

  expect(page).toContain("sixb_query_")
  expect(page).not.toContain('"Node Type":"Seq Scan"')
  expect(removedByFilter(page)).toBe(0)

  const range = await explain({
    kind: "page",
    pageSize: 20,
    input: byCode({
      kind: "filter",
      predicate: {
        op: "and",
        items: [
          { op: "gte", propertyId: "code", value: "b", scalarKind: "string" },
          { op: "lt", propertyId: "code", value: "c", scalarKind: "string" },
        ],
      },
      input: start,
    }),
  })

  expect(range).toContain('COLLATE \\"C\\"')
  expect(range).toContain('"Index Cond"')
  expect(removedByFilter(range)).toBe(0)

  const result = await storage.objects.queryObjects!({
    projectId: "bench",
    query: { kind: "page", pageSize: 3, input: byCode(start) },
    includeTotal: false,
  })

  expect(result.objects.map((row) => row.properties.code)).toEqual(["A00001", "A00009", "A00017"])
})
