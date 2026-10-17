import { InMemoryStorage } from "../src"
import { runArtifactStorageContractSuite } from "../src/testing"

runArtifactStorageContractSuite("InMemoryArtifactStorage", {
  createStorage: () => new InMemoryStorage(),
})
