import { runAiLimitStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runAiLimitStorageContractSuite("SqliteAiLimitStorage", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
