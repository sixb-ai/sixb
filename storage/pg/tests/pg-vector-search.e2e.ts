import { test } from "bun:test"
import { verifyVectorSearch } from "../../../packages/core/tests/fixtures/vector-search"
import { PostgresStorage } from "../src"
import { createPgClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

test("PostgreSQL vector search uses pgvector with authorized exact top-k", async () => {
  // The test's own database, so installing pgvector reaches no other test.
  const created = await createTestStorage()
  const { schemaName, connectionString } = created
  // The searches run under a statement timeout; the bulk seed below does not.
  const storage = new PostgresStorage({
    connectionString,
    schemaName,
    max: 5,
    statementTimeoutMillis: 10000,
  })
  const data = createPgClient({ connectionString, schemaName, max: 1 })
  try {
    await data`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`
    await verifyVectorSearch(storage, async () => {
      await data`INSERT INTO objects SELECT project_id,object_type_id,'bulk-' || i, properties,created_at,updated_at,version,last_commit_id
        FROM objects, generate_series(1,10001) AS i WHERE primary_id='d'`
      await data`INSERT INTO object_vectors SELECT v.project_id,v.object_type_id,o.primary_id,profile,configuration,source,source_fingerprint,embedding,v.last_commit_id
        FROM object_vectors v JOIN objects o ON o.project_id=v.project_id AND o.object_type_id=v.object_type_id
        WHERE v.primary_id='d' AND o.primary_id LIKE 'bulk-%'`
    })
  } finally {
    await Promise.all([data.end(), storage.close()])
    await disposeTestStorage(created.storage)
  }
}, 60000)
