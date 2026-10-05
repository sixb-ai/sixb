import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  defineObjectType,
  type ObjectQuery,
  OntologyRegistry,
  prepareObjectQueries,
  prop,
} from "@sixb/core"
import type { PostgresStorage } from "../src"
import { PgObjectStorage } from "../src/objects/storage"
import { createPgClient, type SQL } from "../src/pg-client"
import { runPgTransaction } from "../src/transactions"
import { createTestStorage } from "./helpers"

let storage: PostgresStorage
let sql: SQL
const query: ObjectQuery = { kind: "start", objectTypeId: "Item" }
const request = { projectId: "p", query, facets: [{ propertyId: "status", limit: 1 }] }
beforeAll(async () => {
  const fixture = await createTestStorage()
  storage = fixture.storage
  sql = createPgClient({
    connectionString: process.env.DATABASE_URL,
    schemaName: fixture.schemaName,
    max: 5,
  })
  await sql`INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id)
    SELECT 'p','Item',n::text,jsonb_build_object('status',CASE WHEN n%2=0 THEN 'active' ELSE 'paused' END),now(),now(),1,'seed' FROM generate_series(1,20) n`
  await prepareObjectQueries({
    projectId: "p",
    storage,
    ontology: new OntologyRegistry({
      sources: [
        defineObjectType({
          id: "Item",
          name: "Item",
          properties: [
            prop("id", "string", { primary: true, required: true }),
            prop("status", "string", { query: { searchable: true, facet: true } }),
          ],
        }),
      ],
    }),
  })
})
afterAll(async () => {
  await sql?.end()
  await storage?.dropSchema()
  await storage?.close()
})

// Guard removal: restore the old migration tables/triggers or cache results without invalidation.
// Preparation must leave writes independent of shared aggregate state, with exact live reads.
test("counts and facets stay exact without maintained state or cache", async () => {
  const [structures] = await sql`SELECT to_regclass('object_query_state') AS state,
    to_regclass('object_query_facet_counts') AS facets,
    (SELECT count(*) FROM pg_trigger WHERE tgrelid='objects'::regclass AND NOT tgisinternal
      AND tgname LIKE 'objects_query_%') AS triggers`
  expect(structures!.state).toBeNull()
  expect(structures!.facets).toBeNull()
  expect(Number(structures!.triggers)).toBe(0)
  expect(await storage.objects.facetObjects!(request)).toEqual({
    total: 20,
    facets: [{ propertyId: "status", buckets: [{ value: "active", count: 10 }] }],
  })
  await sql`UPDATE objects SET properties='{"status":"active"}' WHERE project_id='p' AND primary_id='1'`
  expect((await storage.objects.facetObjects!(request)).facets[0]!.buckets).toEqual([
    { value: "active", count: 11 },
  ])
  await sql`INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id) VALUES
    ('p','Item','null','{"status":null}',now(),now(),1,'seed'),
    ('p','Item','missing','{}',now(),now(),1,'seed')`
  expect((await storage.objects.countObjects!({ projectId: "p", query })).count).toBe(22)
  const all = await storage.objects.facetObjects!({
    ...request,
    facets: [{ propertyId: "status", limit: 10 }],
  })
  expect(all.total).toBe(22)
  expect(all.facets[0]!.buckets).toContainEqual({ value: null, count: 1 })
  expect(all.facets[0]!.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(21)
  await expect(
    runPgTransaction(sql, async (tx) => {
      await tx`DELETE FROM objects WHERE project_id='p' AND primary_id='2'`
      expect((await new PgObjectStorage(tx).countObjects({ projectId: "p", query })).count).toBe(21)
      throw new Error("rollback")
    })
  ).rejects.toThrow("rollback")
  expect((await storage.objects.countObjects!({ projectId: "p", query })).count).toBe(22)
  await sql`DELETE FROM objects WHERE project_id='p' AND primary_id IN ('null','missing')`
  expect((await storage.objects.countObjects!({ projectId: "p", query })).count).toBe(20)
})

// Guard removal: group by ->> text in compilePgFacetSummary instead of JSONB.
// 1.0 and 1.00 then become two buckets although PostgreSQL considers them equal.
test("numeric facet scales share equality on the live aggregate path", async () => {
  await sql`INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id) VALUES
    ('p','Item','scale-a','{"status":1.0}',now(),now(),1,'seed'),
    ('p','Item','scale-b','{"status":1.00}',now(),now(),1,'seed')`
  const result = await storage.objects.facetObjects!({
    ...request,
    facets: [{ propertyId: "status", limit: 20 }],
  })
  expect(result.facets[0]!.buckets).toContainEqual({ value: 1, count: 2 })
  await sql`DELETE FROM objects WHERE project_id='p' AND primary_id='scale-b'`
  const next = await storage.objects.facetObjects!({
    ...request,
    facets: [{ propertyId: "status", limit: 20 }],
  })
  expect(next.facets[0]!.buckets).toContainEqual({ value: 1, count: 1 })
  await sql`DELETE FROM objects WHERE project_id='p' AND primary_id='scale-a'`
})
