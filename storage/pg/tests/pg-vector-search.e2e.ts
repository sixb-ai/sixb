import { test } from "bun:test"
import { migrateStorage } from "@sixb/core"
import { verifyVectorSearch } from "../../../packages/core/tests/fixtures/vector-search"
import { PostgresStorage } from "../src"
import { quoteIdent } from "../src/migrations"
import { createPgClient } from "../src/pg-client"

test("PostgreSQL vector search uses pgvector with authorized exact top-k", async () => {
  // Extensions are database-wide. Isolate this test from persistence checks that require none.
  const databaseName = `vector_search_${crypto.randomUUID().replaceAll("-", "")}`
  const admin = createPgClient({
    connectionString: process.env.DATABASE_URL!,
    schemaName: "public",
    max: 1,
  })
  const url = new URL(process.env.DATABASE_URL!)
  url.pathname = `/${databaseName}`
  const connectionString = url.toString()
  const schemaName = "vector_search"
  const storage = new PostgresStorage({
    connectionString,
    schemaName,
    max: 5,
    statementTimeoutMillis: 10000,
  })
  const sql = createPgClient({
    connectionString,
    schemaName: "public",
    max: 1,
    statementTimeoutMillis: 10000,
  })
  try {
    await admin.unsafe(`CREATE DATABASE ${quoteIdent(databaseName)}`)
    await migrateStorage(storage)
    await sql`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`
    const data = createPgClient({
      connectionString,
      schemaName,
      max: 1,
      statementTimeoutMillis: 10000,
    })
    try {
      await verifyVectorSearch(storage, async () => {
        await data`INSERT INTO objects SELECT project_id,object_type_id,'bulk-' || i, properties,created_at,updated_at,version,last_commit_id
          FROM objects, generate_series(1,10001) AS i WHERE primary_id='d'`
        await data`INSERT INTO object_vectors SELECT v.project_id,v.object_type_id,o.primary_id,profile,configuration,source,source_fingerprint,embedding,v.last_commit_id
          FROM object_vectors v JOIN objects o ON o.project_id=v.project_id AND o.object_type_id=v.object_type_id
          WHERE v.primary_id='d' AND o.primary_id LIKE 'bulk-%'`
      })
    } finally {
      await data.end()
    }
  } finally {
    try {
      await Promise.all([sql.end(), storage.close()])
    } finally {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`)
      } finally {
        await admin.end()
      }
    }
  }
}, 60000)
