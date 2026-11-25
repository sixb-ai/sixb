import { InMemoryStorage } from "../src/storage"
import { runDeclaredPropertiesContractSuite } from "../src/testing"

runDeclaredPropertiesContractSuite("In-memory storage", {
  createStorage: async () => new InMemoryStorage(),
})
