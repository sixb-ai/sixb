import type { LakeRetentionRunStorage } from "@sixb/core/storage"
import { runLakeRetentionRunStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

const storages = new Map<LakeRetentionRunStorage, SqliteStorage>()

runLakeRetentionRunStorageContractSuite("SqliteLakeRetentionRunStorage", {
  createStorage: () => {
    const storage = new SqliteStorage()
    storages.set(storage.lakeRetentionRuns, storage)
    return storage.lakeRetentionRuns
  },
  cleanup: (runs) => {
    storages.get(runs)?.close()
    storages.delete(runs)
  },
})
