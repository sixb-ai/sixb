import { runUniqueValuesContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runUniqueValuesContractSuite("SQLite unique values", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
