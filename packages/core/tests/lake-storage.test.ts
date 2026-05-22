import { InMemoryLakeStorage } from "../src"
import { runLakeStorageContractSuite } from "../src/testing"

runLakeStorageContractSuite("InMemoryLakeStorage", {
  createStorage: () => new InMemoryLakeStorage(),
})
