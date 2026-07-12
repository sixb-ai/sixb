import { InMemoryBlobStorage } from "../src"
import { runBlobStorageContractSuite } from "../src/testing"

runBlobStorageContractSuite("InMemoryBlobStorage contract", {
  createStorage: () => new InMemoryBlobStorage(),
})
