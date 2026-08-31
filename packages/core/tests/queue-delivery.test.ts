import { describe, expect, test } from "bun:test"
import { InMemoryQueues } from "../src"
import type { ClaimedQueueJob, SyncRunRequestedQueueJob } from "../src/queues"
import { createQueueDelivery } from "../src/workers/queue-delivery"

const PROJECT_ID = "queue-delivery-tests"

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
      await Bun.sleep(150)
      expect(await delivery.complete()).toBe("settled")
      expect(delivery.state).toBe("settled")
      expect(renewals).toBeGreaterThanOrEqual(2)
      expect(confirmedExpirations.length).toBeGreaterThanOrEqual(2)
      expect(Date.parse(confirmedExpirations.at(-1) ?? "")).toBeGreaterThan(
        Date.parse(claimed.leaseExpiresAt)
      )
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
      await Bun.sleep(25)
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
      await Bun.sleep(75)
      expect(delivery.state).toBe("active")
      expect(attempts).toBeGreaterThanOrEqual(2)
      expect(reportedErrors).toBe(1)
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
      await Bun.sleep(60)
      expect(delivery.state).toBe("lost")
      expect(delivery.signal.aborted).toBe(true)
    } finally {
      await delivery.close()
    }
  })
})
