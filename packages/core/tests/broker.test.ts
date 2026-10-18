import { afterEach, beforeEach, jest } from "bun:test"
import { InMemoryBroker } from "../src/broker"
import { runBrokerContractSuite } from "../src/testing"

// The in-memory broker reads only `Date.now()` and delivers on microtasks, so the suite's
// retention and delivery waits run on fake timers. `setImmediate` stays real and drains each
// delivery before the next check.
beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

runBrokerContractSuite("InMemoryBroker", {
  createBroker: () => new InMemoryBroker(),
  sleep: async (ms) => {
    jest.advanceTimersByTime(ms)
    await new Promise<void>((resolve) => setImmediate(resolve))
  },
})
