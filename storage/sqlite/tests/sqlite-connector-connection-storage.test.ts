import { runConnectorConnectionStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"
import { getSqliteStorageTestingAdapter } from "../src/testing"

runConnectorConnectionStorageContractSuite("SqliteConnectorConnectionStorage", {
  createStorage: () => new SqliteStorage(),
  advanceTime: (storage, durationMs) =>
    getSqliteStorageTestingAdapter(storage).advanceConnectorConnectionTime(durationMs),
  teardown: (storage) => storage.close(),
})
