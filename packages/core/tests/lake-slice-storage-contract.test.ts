import { InMemoryLakeSliceStorage } from "../src/storage/lake-slices"
import { runLakeSliceStorageContractSuite } from "../src/testing"

runLakeSliceStorageContractSuite("InMemoryLakeSliceStorage", {
  createStorage: () => new InMemoryLakeSliceStorage(),
})
