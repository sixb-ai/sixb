import { runArtifactStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runArtifactStorageContractSuite("SqliteArtifactStorage", {
  createStorage: () => new SqliteStorage(),
  teardown: (storage) => storage.close(),
})
