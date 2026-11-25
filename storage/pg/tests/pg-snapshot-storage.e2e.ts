import { runSnapshotReadContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createPgClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

const connections = new WeakMap<PostgresStorage, { url: string; schema: string }>()

async function testStorage(): Promise<PostgresStorage> {
  const { storage, connectionString, schemaName } = await createTestStorage()
  connections.set(storage, { url: connectionString, schema: schemaName })
  return storage
}

/** A client on a test storage's database, closed after `run`. */
async function withClient<T>(
  storage: PostgresStorage,
  schema: string | undefined,
  run: (sql: ReturnType<typeof createPgClient>) => Promise<T>
): Promise<T> {
  const connection = connections.get(storage)
  if (!connection) throw new Error("Expected a test storage.")

  const sql = createPgClient({
    connectionString: connection.url,
    schemaName: schema ?? connection.schema,
    max: 1,
  })
  try {
    return await run(sql)
  } finally {
    await sql.end()
  }
}

runSnapshotReadContractSuite("PostgreSQL storage", {
  createStorage: testStorage,
  cleanup: (storage) => disposeTestStorage(storage),
  // Ranges come from the statistics of a type's partition.
  beforeRanges: (storage) =>
    withClient(storage, undefined, async (sql) => {
      await sql`ANALYZE`
    }),
})
