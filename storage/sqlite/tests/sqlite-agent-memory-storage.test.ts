import { runAgentMemoryStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runAgentMemoryStorageContractSuite("SqliteAgentMemoryStore", {
  createStorage: () => new SqliteStorage(),
  teardown: (storage) => storage.close(),
})
