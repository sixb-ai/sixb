import { InMemoryLakeRetentionRunStorage } from "../src/storage/lake-retention-runs"
import { runLakeRetentionRunStorageContractSuite } from "../src/testing"

runLakeRetentionRunStorageContractSuite("InMemoryLakeRetentionRunStorage", {
  createStorage: () => new InMemoryLakeRetentionRunStorage(),
})
