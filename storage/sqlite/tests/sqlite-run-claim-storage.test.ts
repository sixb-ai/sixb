import { runRunClaimStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runRunClaimStorageContractSuite("SqliteStorage run claims", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
