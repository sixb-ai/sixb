import { afterEach, beforeEach, jest } from "bun:test"
import { InMemoryQueues } from "../src"
import { runQueueContractSuite } from "../src/testing"

// In-memory leases, delays, and waiting claims read `Date.now()` and `setTimeout`, so the suite's
// waits run on fake timers. `setImmediate` stays real and lets a woken claim finish before the
// next check.
beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

runQueueContractSuite("InMemoryQueues", {
  createQueues: () => new InMemoryQueues(),
  sleep: async (ms) => {
    jest.advanceTimersByTime(ms)
    await new Promise<void>((resolve) => setImmediate(resolve))
  },
})
