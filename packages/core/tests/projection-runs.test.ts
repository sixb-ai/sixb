import { InMemoryProjectionRunStorage } from "../src/storage"
import { runProjectionRunStorageContractSuite } from "../src/testing"

runProjectionRunStorageContractSuite("InMemoryProjectionRunStorage", {
  createStorage: () => new InMemoryProjectionRunStorage(),
})
