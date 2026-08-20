import { runShareSessionStorageContractSuite } from "@sixb/core/testing"
import { SqliteShareSessionStorage } from "../src/share-session-storage"

runShareSessionStorageContractSuite("SqliteShareSessionStorage", {
  createStorage: () => new SqliteShareSessionStorage(),
  cleanup: (storage) => storage.close(),
})
