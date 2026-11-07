import { runRunClaimStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createPgClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage, type TestStorage } from "./helpers"

const connections = new WeakMap<PostgresStorage, TestStorage>()

runRunClaimStorageContractSuite("PostgresStorage run claims", {
  async createStorage() {
    const test = await createTestStorage()
    connections.set(test.storage, test)
    return test.storage
  },
  cleanup: disposeTestStorage,
  async forgetExecution(storage, table, id) {
    const { connectionString, schemaName } = connections.get(storage) as TestStorage
    const sql = createPgClient({ connectionString, schemaName, max: 1 })

    await sql.unsafe(
      `UPDATE ${table} SET execution_token = NULL, execution_queue_lease_expires_at = NULL WHERE id = $1`,
      [id]
    )
    await sql.end()
  },
})
