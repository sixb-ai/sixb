import { InMemoryQueues } from "../src"
import { runQueueContractSuite } from "../src/testing"

runQueueContractSuite("InMemoryQueues", {
  createQueues: () => new InMemoryQueues(),
})
