import { runShareGrantStorageContractSuite } from "@sixb/core/testing"
import { SqliteShareGrantStorage } from "../src/share-grant-storage"

runShareGrantStorageContractSuite("SqliteShareGrantStorage", {
  createStorage: () => new SqliteShareGrantStorage(),
  cleanup: (storage) => storage.close(),
})
