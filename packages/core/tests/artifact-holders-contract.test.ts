import { InMemoryStorage } from "../src"
import { runArtifactHoldersContractSuite } from "../src/testing"

runArtifactHoldersContractSuite("in-memory artifact holders", {
  createStorage: () => new InMemoryStorage(),
})
