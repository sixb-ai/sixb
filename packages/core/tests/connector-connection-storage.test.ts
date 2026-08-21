import { InMemoryConnectorConnectionStorage } from "../src/storage"
import { runConnectorConnectionStorageContractSuite } from "../src/testing"

runConnectorConnectionStorageContractSuite("InMemoryConnectorConnectionStorage", {
  createStorage: () => new InMemoryConnectorConnectionStorage(),
})
