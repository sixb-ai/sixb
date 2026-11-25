import { runDeclaredPropertiesContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runDeclaredPropertiesContractSuite("SQLite storage", {
  createStorage: async () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
