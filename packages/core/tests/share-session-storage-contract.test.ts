import { InMemoryShareSessionStorage } from "../src/storage/share-sessions"
import { runShareSessionStorageContractSuite } from "../src/testing"

runShareSessionStorageContractSuite("InMemoryShareSessionStorage", {
  createStorage: () => new InMemoryShareSessionStorage(),
})
