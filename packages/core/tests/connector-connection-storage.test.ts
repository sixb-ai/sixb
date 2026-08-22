import { InMemoryConnectorConnectionStorage } from "../src/storage/connector-connections"
import { runConnectorConnectionStorageContractSuite } from "../src/testing"

runConnectorConnectionStorageContractSuite("InMemoryConnectorConnectionStorage", {
  createStorage: () => new InMemoryConnectorConnectionStorage(),
})
