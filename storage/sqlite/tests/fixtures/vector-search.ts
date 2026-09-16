import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage } from "@sixb/core"
import { verifyVectorSearch } from "../../../../packages/core/tests/fixtures/vector-search"
import { SqliteStorage } from "../../src"
import { sqliteStoragePath } from "../../src/migrations"

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
} finally {
  db.close()
  await storage.close()
  await rm(path, { recursive: true, force: true })
}
