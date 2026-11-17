import { InMemoryBranchStorage } from "../src/storage/branches"
import { runBranchStorageContractSuite } from "../src/testing"

runBranchStorageContractSuite("InMemoryBranchStorage", {
  createStorage: () => new InMemoryBranchStorage(),
})
