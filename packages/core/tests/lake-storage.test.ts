import { InMemoryLakeStorage } from "../src"
import { runLakeMergeStorageContractSuite, runLakeStorageContractSuite } from "../src/testing"

runLakeStorageContractSuite("InMemoryLakeStorage", {
  createStorage: () => new InMemoryLakeStorage(),
})

runLakeMergeStorageContractSuite("InMemoryLakeStorage merge contract", {
  createStorage: () => new InMemoryLakeStorage(),
})
