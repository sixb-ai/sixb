import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { InMemoryQueues } from "../src"
import type { ClaimedQueueJob, SyncRunRequestedQueueJob } from "../src/queues"
import { createQueueDelivery } from "../src/workers/queue-delivery"

const PROJECT_ID = "queue-delivery-tests"

// Leases and renewals run on fake time: a renewal fires every third of `leaseMs`.
beforeEach(() => {
  jest.useFakeTimers()
})
afterEach(() => {
  jest.useRealTimers()
})

/** `setImmediate` stays real under Bun's fake timers, so this drains every pending microtask. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms)
  await flush()
}

async function claimOne(
  queues: InMemoryQueues,
  leaseMs: number
): Promise<ClaimedQueueJob<SyncRunRequestedQueueJob>> {
  await queues.syncRuns.enqueue({
    projectId: PROJECT_ID,
    jobs: [{ type: "sync.run.requested", payload: { runId: "sync" } }],
  })
  const [claimed] = await queues.syncRuns.claim({
    projectId: PROJECT_ID,
    workerId: "worker",
    leaseMs,
  })
  if (!claimed) throw new Error("Expected a claimed queue job.")
  return claimed
}

describe("QueueDelivery", () => {
  test("renews ownership until a long-running delivery completes", async () => {
    const queues = new InMemoryQueues()
    const leaseMs = 60
    const claimed = await claimOne(queues, leaseMs)
    const originalRenew = queues.syncRuns.renewLease?.bind(queues.syncRuns)
    if (!originalRenew) throw new Error("Expected queue renewal support.")
    let renewals = 0
    queues.syncRuns.renewLease = async (params) => {
      renewals += 1
      return originalRenew(params)
    }

    const delivery = createQueueDelivery({
      queue: queues.syncRuns,
      claimed,
      leaseMs,
      signal: new AbortController().signal,
    })
    const confirmedExpirations: string[] = []
    const stopObserving = delivery.onLeaseRenewed((renewed) => {
      confirmedExpirations.push(renewed.leaseExpiresAt)
    })
    try {
      for (let third = 0; third < 3; third++) await advance(leaseMs / 3)
      expect(renewals).toBe(3)
      expect(confirmedExpirations).toHaveLength(3)
      // The last renewal outlives the original lease by the time that has passed.
      expect(Date.parse(confirmedExpirations.at(-1) ?? "")).toBe(
        Date.parse(claimed.leaseExpiresAt) + leaseMs
      )
      expect(delivery.leaseExpiresAt).toBe(confirmedExpirations.at(-1)!)
      expect(await delivery.complete()).toBe("settled")
      expect(delivery.state).toBe("settled")
    } finally {
      stopObserving()
      await delivery.close()
    }

    const redelivered = await queues.syncRuns.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(redelivered).toHaveLength(0)
  })

  test("aborts the delivery and refuses settlement after definitive lease loss", async () => {
    const queues = new InMemoryQueues()
    const leaseMs = 45
    const claimed = await claimOne(queues, leaseMs)
    let completeCalls = 0
    queues.syncRuns.renewLease = async () => null
    queues.syncRuns.complete = async () => {
      completeCalls += 1
    }

    const delivery = createQueueDelivery({
      queue: queues.syncRuns,
      claimed,
      leaseMs,
      signal: new AbortController().signal,
    })
    try {
      await advance(leaseMs / 3)
      expect(delivery.state).toBe("lost")
      expect(delivery.signal.aborted).toBe(true)
      expect(await delivery.complete()).toBe("lost")
      expect(completeCalls).toBe(0)
    } finally {
      await delivery.close()
    }
  })

  test("retries transient renewal failures while the confirmed lease is valid", async () => {
    const queues = new InMemoryQueues()
    const leaseMs = 90
    const claimed = await claimOne(queues, leaseMs)
    const originalRenew = queues.syncRuns.renewLease?.bind(queues.syncRuns)
    if (!originalRenew) throw new Error("Expected queue renewal support.")
    let attempts = 0
    let reportedErrors = 0
    queues.syncRuns.renewLease = async (params) => {
      attempts += 1
      if (attempts === 1) throw new Error("temporary queue outage")
      return originalRenew(params)
    }

    const delivery = createQueueDelivery({
      queue: queues.syncRuns,
      claimed,
      leaseMs,
      signal: new AbortController().signal,
      onRenewalError: () => {
        reportedErrors += 1
      },
    })
    try {
      await advance(leaseMs / 3)
      expect(attempts).toBe(1)
      expect(reportedErrors).toBe(1)
      expect(delivery.state).toBe("active")
      await advance(leaseMs / 3)
      expect(attempts).toBe(2)
      expect(delivery.leaseExpiresAt).not.toBe(claimed.leaseExpiresAt)
      expect(await delivery.complete()).toBe("settled")
      expect(delivery.state).toBe("settled")
    } finally {
      await delivery.close()
    }
  })

  test("marks the delivery lost when renewal does not finish before expiration", async () => {
    const queues = new InMemoryQueues()
    const leaseMs = 45
    const claimed = await claimOne(queues, leaseMs)
    queues.syncRuns.renewLease = () => new Promise(() => {})

    const delivery = createQueueDelivery({
      queue: queues.syncRuns,
      claimed,
      leaseMs,
      signal: new AbortController().signal,
    })
    try {
      // The renewal starts at the first third and is still pending one tick before expiry.
      await advance(leaseMs / 3)
      await advance((leaseMs * 2) / 3 - 1)
      expect(delivery.state).toBe("active")
      await advance(1)
      expect(delivery.state).toBe("lost")
      expect(delivery.signal.aborted).toBe(true)
    } finally {
      await delivery.close()
    }
  })
})
