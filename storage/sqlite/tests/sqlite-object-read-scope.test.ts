import type { ObjectReadScopeFactory, ObjectStorage } from "@sixb/core/storage"
import { runObjectReadScopeContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runObjectReadScopeContractSuite("SqliteStorage selected object-read scope contract", {
  createHarness: () => {
    const storage = new SqliteStorage()
    return {
      storage,
      // Storage activation is a later slice. The provider facade already preserves the concrete
      // factory method, so this contract can validate SQLite independently in the meantime.
      objectReadScopeFactory: storage.objects as ObjectStorage & ObjectReadScopeFactory,
    }
  },
  teardown: ({ storage }) => storage.close(),
})
