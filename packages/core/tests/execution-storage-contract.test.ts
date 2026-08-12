import { InMemoryStorage } from "@sixb/core"
import { runExecutionStorageContractSuite } from "../src/testing"

runExecutionStorageContractSuite("InMemoryStorage execution ledger", {
  createStorage: () => new InMemoryStorage(),
})
