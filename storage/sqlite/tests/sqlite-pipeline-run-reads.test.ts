import { runPipelineRunReadContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runPipelineRunReadContractSuite("SqliteStorage", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
