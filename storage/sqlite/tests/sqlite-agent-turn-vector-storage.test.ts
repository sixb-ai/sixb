import { runAgentTurnVectorStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runAgentTurnVectorStorageContractSuite("SqliteAgentTurnVectorStore", {
  createStorage: () => new SqliteStorage(),
  teardown: (storage) => storage.close(),
})
