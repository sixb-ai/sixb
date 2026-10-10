import { runActionRunStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runActionRunStorageContractSuite("SqliteStorage Action runs", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
