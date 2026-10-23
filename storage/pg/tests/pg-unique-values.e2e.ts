import { runUniqueValuesContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage, disposeTestStorage, waitForLockWait } from "./helpers"

const connectionStrings = new WeakMap<PostgresStorage, string>()

runUniqueValuesContractSuite("PostgreSQL unique values", {
  createStorage: async () => {
    const { storage, connectionString } = await createTestStorage()
    connectionStrings.set(storage, connectionString)
    return storage
  },
  cleanup: (storage) => disposeTestStorage(storage),
  waitForLockWait: (storage, competing) => {
    const connectionString = connectionStrings.get(storage)
    if (!connectionString) throw new Error("Expected a test storage's connection string.")

    return waitForLockWait(connectionString, competing)
  },
})
