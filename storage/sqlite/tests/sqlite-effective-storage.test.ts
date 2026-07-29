import { runEffectiveStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runEffectiveStorageContractSuite("SqliteStorage", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
