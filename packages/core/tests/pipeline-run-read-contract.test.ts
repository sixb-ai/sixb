import { InMemoryStorage } from "../src"
import { runPipelineRunReadContractSuite } from "../src/testing"

runPipelineRunReadContractSuite("InMemoryStorage", {
  createStorage: () => new InMemoryStorage(),
})
