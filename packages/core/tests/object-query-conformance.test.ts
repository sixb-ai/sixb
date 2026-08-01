import { InMemoryStorage } from "../src/storage"
import { runObjectQueryProviderContractSuite } from "../src/testing"

runObjectQueryProviderContractSuite("InMemoryStorage object query provider contract", {
  createStorage: () => new InMemoryStorage(),
})
