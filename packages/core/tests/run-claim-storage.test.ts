import { InMemoryStorage } from "@sixb/core"
import { runRunClaimStorageContractSuite } from "../src/testing"

runRunClaimStorageContractSuite("InMemoryStorage run claims", {
  createStorage: () => new InMemoryStorage(),
})
