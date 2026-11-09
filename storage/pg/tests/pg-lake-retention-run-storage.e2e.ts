import type { LakeRetentionRunStorage } from "@sixb/core/storage"
import { runLakeRetentionRunStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage, disposeTestStorage } from "./helpers"

const storages = new Map<LakeRetentionRunStorage, PostgresStorage>()

runLakeRetentionRunStorageContractSuite("PgLakeRetentionRunStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    storages.set(storage.lakeRetentionRuns, storage)
    return storage.lakeRetentionRuns
  },
  cleanup: async (runs) => {
    const storage = storages.get(runs)
    if (!storage) return
    storages.delete(runs)
    await disposeTestStorage(storage)
  },
})
