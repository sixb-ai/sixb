import type { LakeSliceStorage } from "@sixb/core/storage"
import { runLakeSliceStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage, disposeTestStorage } from "./helpers"

const storages = new Map<LakeSliceStorage, PostgresStorage>()

runLakeSliceStorageContractSuite("PgLakeSliceStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    storages.set(storage.lakeSlices, storage)
    return storage.lakeSlices
  },
  cleanup: async (lakeSlices) => {
    const storage = storages.get(lakeSlices)
    if (!storage) return
    storages.delete(lakeSlices)
    await disposeTestStorage(storage)
  },
})
