import { runObjectReadScopeContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runObjectReadScopeContractSuite("SqliteStorage selected object-read scope contract", {
  createHarness: () => {
    const storage = new SqliteStorage()
    return {
      storage,
      objectReadScopeFactory: storage.objects,
    }
  },
  teardown: ({ storage }) => storage.close(),
})
