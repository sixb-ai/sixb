import { expect, test } from "bun:test"
import { ObjectQueryExecutionError } from "@sixb/core"
import { runAgentTurnVectorStorageContractSuite } from "@sixb/core/testing"
import { createPgClient } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

runAgentTurnVectorStorageContractSuite("PgAgentTurnVectorStore", {
  createStorage: async () => {
    // Each test's own database, so installing pgvector reaches no other test.
    const { storage, connectionString, schemaName } = await createTestStorage()
    const sql = createPgClient({ connectionString, schemaName, max: 1 })
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`
    } finally {
      await sql.end()
    }
    return storage
  },
  teardown: disposeTestStorage,
})

test("refuses to search without pgvector, before reading anything", async () => {
  const { storage } = await createTestStorage()
  try {
    const error = await storage.agents.turnVectors
      .search({
        projectId: "turn-vectors-pgvector",
        configuration: "cfg_model_a",
        vector: [1, 0, 0],
        scope: "all",
        k: 10,
        perThread: 3,
        candidates: 100,
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ObjectQueryExecutionError)
    expect((error as ObjectQueryExecutionError).code).toBe("vector_extension_missing")
  } finally {
    await disposeTestStorage(storage)
  }
})
