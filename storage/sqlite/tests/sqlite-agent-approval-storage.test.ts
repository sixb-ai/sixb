import { runAgentApprovalStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runAgentApprovalStorageContractSuite("SqliteAgentApprovalStore", {
  createStorage: () => new SqliteStorage(),
  teardown: (storage) => storage.close(),
})
