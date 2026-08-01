import { runObjectQueryProviderContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runObjectQueryProviderContractSuite("SqliteStorage object query provider contract", {
  createStorage: () => new SqliteStorage(),
  teardown: (storage) => storage.close(),
})
