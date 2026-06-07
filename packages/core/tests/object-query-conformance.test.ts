import { InMemoryObjectStorage } from "../src/storage"
import { runObjectQueryProviderContractSuite } from "../src/testing"

runObjectQueryProviderContractSuite("InMemoryObjectStorage object query provider contract", {
  createStorage: () => new InMemoryObjectStorage(),
})
