import { InMemoryStorage } from "../src/storage"
import { runEffectiveStorageContractSuite } from "../src/testing"

runEffectiveStorageContractSuite("InMemoryStorage", {
  createStorage: () => new InMemoryStorage(),
})
