import { runAgentTokenRateStorageContractSuite } from "@sixb/core/testing"
import { SqliteAgentTokenRateStore } from "../src/agents/token-rates"
import { freshSqliteDatabase } from "../src/migrations"

runAgentTokenRateStorageContractSuite("SqliteAgentTokenRateStore", {
  createStorage: () => {
    const db = freshSqliteDatabase()
    return { db, agents: { tokenRates: new SqliteAgentTokenRateStore(db) } }
  },
  countStored: async ({ db }) =>
    (db.query("SELECT COUNT(*) AS count FROM agent_token_rates").get() as { count: number }).count,
  teardown: ({ db }) => db.close(),
})
