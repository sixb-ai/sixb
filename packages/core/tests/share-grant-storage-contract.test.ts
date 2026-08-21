import { InMemoryShareGrantStorage } from "../src/storage/share-grants"
import { runShareGrantStorageContractSuite } from "../src/testing"

runShareGrantStorageContractSuite("InMemoryShareGrantStorage", {
  createStorage: () => new InMemoryShareGrantStorage(),
})
