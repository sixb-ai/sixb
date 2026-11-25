import type { BranchStorage } from "@sixb/core/storage"
import { runBranchStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage, disposeTestStorage } from "./helpers"

const storages = new Map<BranchStorage, PostgresStorage>()

runBranchStorageContractSuite("PgBranchStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    storages.set(storage.hostedBranches, storage)
    return storage.hostedBranches
  },
  cleanup: async (branches) => {
    const storage = storages.get(branches)
    if (!storage) return
    storages.delete(branches)
    await disposeTestStorage(storage)
  },
})
