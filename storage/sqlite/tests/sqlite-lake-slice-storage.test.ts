import type { LakeSliceStorage } from "@sixb/core/storage"
import { runLakeSliceStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

const storages = new Map<LakeSliceStorage, SqliteStorage>()

runLakeSliceStorageContractSuite("SqliteLakeSliceStorage", {
  createStorage: () => {
    const storage = new SqliteStorage()
    storages.set(storage.lakeSlices, storage)
    return storage.lakeSlices
  },
  cleanup: (lakeSlices) => {
    storages.get(lakeSlices)?.close()
    storages.delete(lakeSlices)
  },
})
