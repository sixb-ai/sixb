import { InMemoryStorage } from "../src"
import { runUniqueValuesContractSuite } from "../src/testing"

runUniqueValuesContractSuite("in-memory unique values", {
  createStorage: () => new InMemoryStorage(),
  preparesOnClaim: true,
})
