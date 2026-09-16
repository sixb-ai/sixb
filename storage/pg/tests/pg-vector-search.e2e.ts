import { test } from "bun:test"
import { verifyVectorSearch } from "../../../packages/core/tests/fixtures/vector-search"
import { quoteIdent } from "../src/migrations"
import { createPgClient } from "../src/pg-client"
import { createTestStorage } from "./helpers"

test("PostgreSQL vector search uses pgvector with authorized exact top-k", async () => {
  const { storage, schemaName } = await createTestStorage()
  const sql = createPgClient({
    connectionString: process.env.DATABASE_URL!,
    schemaName: "public",
    max: 1,
  })
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`
    const data = createPgClient({ connectionString: process.env.DATABASE_URL!, schemaName, max: 1 })
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
    await sql`DROP EXTENSION IF EXISTS vector`
    await sql.unsafe(`DROP SCHEMA ${quoteIdent(schemaName)} CASCADE`)
    await sql.end()
    await storage.close()
  }
})
