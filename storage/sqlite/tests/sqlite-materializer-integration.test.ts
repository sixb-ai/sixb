import { runMaterializerStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runMaterializerStorageContractSuite("SQLite materializer storage contract", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
