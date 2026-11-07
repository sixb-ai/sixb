import { InMemoryStorage } from "../src/storage"
import { runDatasetIngestStorageContractSuite } from "../src/testing"

runDatasetIngestStorageContractSuite("InMemoryDatasetIngestStorage", {
  createStorage: () => new InMemoryStorage().datasetIngest,
})
