import { runArtifactHoldersContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runArtifactHoldersContractSuite("SQLite artifact holders", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
