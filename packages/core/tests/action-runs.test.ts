import { InMemoryStorage } from "../src/storage"
import { runActionRunStorageContractSuite } from "../src/testing"

runActionRunStorageContractSuite("InMemoryStorage Action runs", {
  createStorage: () => new InMemoryStorage(),
})
