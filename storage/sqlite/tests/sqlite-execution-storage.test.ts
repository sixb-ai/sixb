import { runExecutionStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runExecutionStorageContractSuite("SqliteStorage execution ledger", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
