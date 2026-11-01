import { runAgentTokenRateStorageContractSuite } from "@sixb/core/testing"
import { createPgClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

runAgentTokenRateStorageContractSuite("PgAgentTokenRateStore", {
  createStorage: async () => {
    const { storage, schemaName, connectionString } = await createTestStorage()
    return {
      agents: storage.agents,
      storage,
      sql: createPgClient({ connectionString, schemaName, max: 1 }),
    }
  },
  countStored: async ({ sql }) => {
    const [row] = await sql<
      { count: number }[]
    >`SELECT COUNT(*)::int AS count FROM agent_token_rates`
    return row!.count
  },
  teardown: async ({ storage, sql }) => {
    await sql.end()
    await disposeTestStorage(storage)
  },
})
