import { runObjectQueryProviderContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const parentStorage = new WeakMap<PostgresStorage["objects"], PostgresStorage>()

runObjectQueryProviderContractSuite("PgObjectStorage object query provider contract", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    parentStorage.set(storage.objects, storage)
    return storage.objects
  },
  teardown: async (objects) => {
    const storage = parentStorage.get(objects)
    if (!storage) return
    await storage.dropSchema()
    await storage.close()
  },
})
