import { InMemoryAuthStorage } from "../src/storage"
import { runAuthStorageContractSuite } from "../src/testing"

runAuthStorageContractSuite("InMemoryAuthStorage", {
  createStorage: () => new InMemoryAuthStorage(),
})
