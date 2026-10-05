import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage } from "@sixb/core"
import { verifyVectorSearch } from "../../../../packages/core/tests/fixtures/vector-search"
import { SqliteStorage } from "../../src"
import { sqliteStoragePath } from "../../src/migrations"
import { compileObjectQuery, DEFAULT_OBJECT_QUERY_SOURCE } from "../../src/objects/query-compiler"
import { SqliteObjectReader } from "../../src/objects/reader"
import { ensureSqliteVectorSearch } from "../../src/objects/vector-extension"

if (process.platform === "darwin") {
  const path = process.env.SIXB_TEST_SQLITE_LIBRARY
  if (!path)
    throw new Error("Set SIXB_TEST_SQLITE_LIBRARY to an extension-capable SQLite library on macOS.")
  Database.setCustomSQLite(path)
}
const path = await mkdtemp(join(tmpdir(), "sixb-vector-search-"))
const storage = new SqliteStorage({ path })
await migrateStorage(storage)
const db = new Database(sqliteStoragePath(path))
try {
  await verifyVectorSearch(storage, async () => {
    db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001)
      INSERT INTO objects SELECT project_id,object_type_id,'bulk-' || i, properties,created_at,updated_at,version,last_commit_id
      FROM objects, n WHERE primary_id='d'`)
    db.run(`INSERT INTO object_vectors SELECT v.project_id,v.object_type_id,o.primary_id,profile,configuration,source,source_fingerprint,embedding,v.last_commit_id
      FROM object_vectors v JOIN objects o ON o.project_id=v.project_id AND o.object_type_id=v.object_type_id
      WHERE v.primary_id='d' AND o.primary_id LIKE 'bulk-%'`)
  })
  // Removal proof: restore the separate vector probe/total reads in queryObjects; reads becomes 3.
  // The guard and top-k total must come from the same bounded candidate scan as ranking.
  ensureSqliteVectorSearch(db)
  const state = db
    .query<{ configuration: string }, []>(
      "SELECT configuration FROM object_vectors WHERE primary_id = 'A'"
    )
    .get()!
  const query = {
    kind: "vector" as const,
    input: {
      kind: "filter" as const,
      input: { kind: "start" as const, objectTypeId: "SearchProduct" },
      predicate: { op: "eq" as const, propertyId: "status", value: "tie" },
    },
    profile: "content",
    configuration: state.configuration,
    source: ["title"],
    vector: [1, 0, 0],
    k: 4,
  }
  const reader = new SqliteObjectReader(db, DEFAULT_OBJECT_QUERY_SOURCE)
  const original = db.query.bind(db)
  let reads = 0
  Object.defineProperty(db, "query", {
    configurable: true,
    value: (sql: string) => {
      if (sql.includes("object_vectors")) reads++
      return original(sql)
    },
  })
  try {
    const result = reader.queryObjects({ projectId: "vector-search", query })
    assert.equal(result.total, 4)
    assert.equal(result.objects.length, 4)
    assert.equal(reads, 1)
  } finally {
    Object.defineProperty(db, "query", { configurable: true, value: original })
  }
  for (const includeTotal of [true, false]) {
    for (const limit of [1, 3, 10]) {
      const limited = reader.queryObjects({
        projectId: "vector-search",
        query: {
          kind: "project",
          properties: ["id"],
          input: { kind: "limit", input: query, limit },
        },
        includeTotal,
      })
      assert.equal(limited.objects.length, Math.min(4, limit))
      assert.equal(limited.hasMore, limit < 4)
      if (includeTotal) assert.equal(limited.total, 4)
      for (const object of limited.objects) {
        assert.deepEqual(Object.keys(object.properties), ["id"])
        assert.equal(typeof object.score, "number")
      }
    }
    const result = reader.queryObjects({
      projectId: "vector-search",
      query: { kind: "limit", input: query, limit: 0 },
      includeTotal,
    })
    assert.deepEqual(result.objects, [])
    if (includeTotal) assert.equal(result.total, 4)
    assert.throws(
      () =>
        reader.queryObjects({
          projectId: "vector-search",
          query: { kind: "limit", input: { ...query, input: query.input.input }, limit: 0 },
          includeTotal,
        }),
      /at most/
    )
  }
  // Admission must skip distance work completely on overflow. Replace it with an expression
  // that throws if evaluated, retaining its parameter slot. Removal proof: remove the CASE guard.
  const overBudget = compileObjectQuery("vector-search", { ...query, input: query.input.input })
  const guardedSql = overBudget.sql.replace(
    "vec_distance_cosine(input._vector_embedding, ?)",
    "json_extract('invalid-json', ?)"
  )
  assert.notEqual(guardedSql, overBudget.sql)
  assert.doesNotThrow(() => db.query(guardedSql).all(...overBudget.args))
} finally {
  db.close()
  await storage.close()
  await rm(path, { recursive: true, force: true })
}
