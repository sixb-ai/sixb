import { InMemoryLakeStorage } from "../src/lake-storage"
import { runLakeChangesContractSuite } from "../src/testing/lake-changes-contract"

runLakeChangesContractSuite("InMemoryLakeStorage changes", {
  createStorage: () => new InMemoryLakeStorage(),
})
