import { InMemoryBroker } from "../src/broker"
import { runBrokerContractSuite } from "../src/testing"

runBrokerContractSuite("InMemoryBroker", {
  createBroker: () => new InMemoryBroker(),
})
