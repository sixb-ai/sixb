import { InMemoryStorage } from "../src"
import { runTypeShapesContractSuite } from "../src/testing"

runTypeShapesContractSuite("in-memory type shapes", {
  createStorage: () => new InMemoryStorage(),
})
