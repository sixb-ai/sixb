import type { DatasetIngestStorage } from "@sixb/core/storage"
import { runDatasetIngestStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

const storages = new Map<DatasetIngestStorage, SqliteStorage>()

runDatasetIngestStorageContractSuite("SqliteDatasetIngestStorage", {
  createStorage: () => {
    const storage = new SqliteStorage()
    storages.set(storage.datasetIngest, storage)
    return storage.datasetIngest
  },
  cleanup: (datasetIngest) => {
    storages.get(datasetIngest)?.close()
    storages.delete(datasetIngest)
  },
})
