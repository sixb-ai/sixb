import { afterAll, describe, expect, mock, test } from "bun:test"
import { runQueueContractSuite } from "@sixb/core/testing"
import IORedis from "ioredis"
import { BullMqQueues } from "../src"
import {
  closeSharedConnection,
  closeSharedProvider,
  createBorrowedConnection,
  createTestQueues,
  flushSharedRedis,
  getSharedProvider,
  requireRedisUrl,
} from "./helpers"

const openedProviders: BullMqQueues[] = []

// Contract suite uses a single shared provider for all test cases, with Redis state reset
// between cases via FLUSHDB. Creating/closing BullMQ Workers per test races with their
// internal blocking-connection teardown and flakes on Bun ≥ 1.3.13 — see issue #2686.
runQueueContractSuite("BullMqQueues", {
  createQueues: () => getSharedProvider(),
  teardown: async () => {
    await flushSharedRedis()
  },
  shortLeaseMs: 150,
  retryRedeliveryMs: 200,
  leaseExpiryRedeliveryMs: 300,
})

describe("BullMqQueues (Redis-specific)", () => {
  afterAll(async () => {
    await Promise.all(openedProviders.map((provider) => provider.close()))
    await closeSharedProvider()
    await closeSharedConnection()
  })

  describe("prefix isolation", () => {
    test("two providers with different prefixes do not see each other's jobs", async () => {
      const providerA = createTestQueues()
      const providerB = createTestQueues()

      try {
        await providerA.syncRuns.enqueue({
          projectId: "shared-project",
          jobs: [{ type: "sync.run.requested", payload: { syncId: "a-1" } }],
        })

        const claimedByB = await providerB.syncRuns.claim({
          projectId: "shared-project",
          workerId: "worker-b",
          limit: 10,
        })
        const claimedByA = await providerA.syncRuns.claim({
          projectId: "shared-project",
          workerId: "worker-a",
          limit: 10,
        })

        expect(claimedByB).toHaveLength(0)
        expect(claimedByA).toHaveLength(1)
        expect(claimedByA[0]?.job.payload.syncId).toBe("a-1")
      } finally {
        await providerA.close()
        await providerB.close()
      }
    })
  })

  describe("connection ownership", () => {
    test("enqueue-only workloads do not create a blocking duplicate connection", async () => {
      const borrowed = createBorrowedConnection()
      const originalDuplicate = borrowed.duplicate.bind(borrowed)
      const duplicateSpy = mock(originalDuplicate)
      borrowed.duplicate = duplicateSpy as typeof borrowed.duplicate
      const provider = new BullMqQueues({ connection: borrowed, prefix: "sixb-test-borrowed" })

      try {
        await provider.syncRuns.enqueue({
          projectId: "project-a",
          jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
        })

        expect(duplicateSpy).not.toHaveBeenCalled()
      } finally {
        await provider.close()
        await borrowed.quit()
      }
    })

    test("borrowed IORedis client survives close()", async () => {
      const borrowed = createBorrowedConnection()
      const provider = new BullMqQueues({ connection: borrowed, prefix: "sixb-test-borrowed" })

      try {
        await provider.syncRuns.enqueue({
          projectId: "project-a",
          jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
        })
        await provider.close()

        const pong = await borrowed.ping()
        expect(pong).toBe("PONG")
      } finally {
        await borrowed.quit()
      }
    })

    test("rejects a borrowed IORedis without maxRetriesPerRequest: null", () => {
      const misconfigured = new IORedis(requireRedisUrl(), { lazyConnect: true })

      try {
        expect(() => new BullMqQueues({ connection: misconfigured })).toThrow(
          /maxRetriesPerRequest/
        )
      } finally {
        misconfigured.disconnect()
      }
    })
  })

  describe("stalled redelivery", () => {
    test("redelivers via BullMQ's stalled check when the lock expires", async () => {
      const provider = createTestQueues({ defaultLeaseMs: 100, stalledInterval: 50 })
      openedProviders.push(provider)

      const [job] = await provider.syncRuns.enqueue({
        projectId: "project-a",
        jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
      })
      const [firstClaim] = await provider.syncRuns.claim({
        projectId: "project-a",
        workerId: "worker-1",
      })

      await Bun.sleep(300)
      const [secondClaim] = await provider.syncRuns.claim({
        projectId: "project-a",
        workerId: "worker-2",
      })

      expect(firstClaim?.job.attempt).toBe(1)
      expect(secondClaim?.job.id).toBe(job?.id)
      expect(secondClaim!.job.attempt).toBeGreaterThanOrEqual(2)
    })
  })

  describe("close", () => {
    test("operations after close throw QueueError", async () => {
      const provider = createTestQueues()
      await provider.close()

      await expect(
        provider.syncRuns.enqueue({
          projectId: "project-a",
          jobs: [{ type: "sync.run.requested", payload: { syncId: "s-1" } }],
        })
      ).rejects.toThrow(/closed/i)
    })

    test("close is idempotent", async () => {
      const provider = createTestQueues()

      await provider.close()
      await provider.close()
    })
  })
})
