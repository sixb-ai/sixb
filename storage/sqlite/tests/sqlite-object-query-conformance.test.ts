import { runObjectQueryProviderContractSuite } from "@sixb/core/testing"
import { SqliteObjectStorage } from "../src"

runObjectQueryProviderContractSuite("SqliteObjectStorage object query provider contract", {
  createStorage: () => new SqliteObjectStorage(),
  teardown: (storage) => storage.close(),
})
