import { runAgentInboxStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runAgentInboxStorageContractSuite("SqliteAgentInboxStore", {
  createStorage: () => new SqliteStorage(),
  teardown: (storage) => storage.close(),
})
