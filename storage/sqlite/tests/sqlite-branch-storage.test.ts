import type { BranchStorage } from "@sixb/core/storage"
import { runBranchStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

const storages = new Map<BranchStorage, SqliteStorage>()

runBranchStorageContractSuite("SqliteBranchStorage", {
  createStorage: () => {
    const storage = new SqliteStorage()
    storages.set(storage.branches, storage)
    return storage.branches
  },
  cleanup: (branches) => {
    storages.get(branches)?.close()
    storages.delete(branches)
  },
})
