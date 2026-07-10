import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { runBrokerContractSuite } from "@sixb/core/testing"
import { RedisBroker } from "../src"
import { createTestBroker, requireRedisUrl } from "./helpers"

runBrokerContractSuite("RedisBroker", {
  createBroker: async () => createTestBroker().broker,
  teardown: async (broker) => {
    await broker.close()
  },
  maxAgeMs: 1_000,
  maxAgeWaitMs: 1_500,
  subscriptionSetupMs: 150,
  subscriptionDeliveryTimeoutMs: 5_000,
  subscriptionPollIntervalMs: 25,
})

describe("RedisBroker", () => {
  test("rejects fractional numeric options", () => {
    expect(
      () =>
        new RedisBroker({
          connection: { url: requireRedisUrl() },
          subscribeBlockMs: 0.5,
        })
    ).toThrow("positive finite integers")
  })

  test("uses Redis environment defaults when connection is omitted", async () => {
    const previousRedisUrl = process.env["REDIS_URL"]
    process.env["REDIS_URL"] = requireRedisUrl()

    const suffix = randomUUID().slice(0, 8)
    const broker = new RedisBroker({
      prefix: `sixb:test:broker:${suffix}`,
      subscribeBlockMs: 100,
    })
    const projectId = `project-${suffix}`
    const stream = { id: "__events" }

    try {
      await broker.ensureStream({ projectId, stream })
      const [record] = await broker.append({
        projectId,
        streamId: stream.id,
        records: [{ name: "object.upserted", payload: { id: "room-1" } }],
      })

      expect(await broker.read({ projectId, streamId: stream.id })).toEqual([record])
    } finally {
      await broker.close()
      if (previousRedisUrl === undefined) {
        delete process.env["REDIS_URL"]
      } else {
        process.env["REDIS_URL"] = previousRedisUrl
      }
    }
  })

  test("deduplicates records by idempotencyKey within the configured retry window", async () => {
    const { broker, projectId, cleanup } = createTestBroker()
    const stream = { id: "__events" }
    try {
      await broker.ensureStream({ projectId, stream })
      const [first] = await broker.append({
        projectId,
        streamId: stream.id,
        records: [
          {
            name: "object.upserted",
            payload: { id: "room-1" },
            idempotencyKey: "dedupe-room-1",
          },
        ],
      })
      const [second] = await broker.append({
        projectId,
        streamId: stream.id,
        records: [
          {
            name: "object.upserted",
            payload: { id: "room-2" },
            idempotencyKey: "dedupe-room-1",
          },
        ],
      })

      expect(first).toBeDefined()
      expect(second?.cursor).toBe(first?.cursor)
      expect(second?.payload).toEqual({ id: "room-1" })
      expect(await broker.read({ projectId, streamId: stream.id })).toEqual([first])
    } finally {
      await cleanup()
    }
  })

  test("handles concurrent appends and retained reads on the shared command client", async () => {
    const { broker, projectId, cleanup } = createTestBroker()
    const stream = { id: "__concurrent_events" }
    try {
      await broker.ensureStream({ projectId, stream })

      const appendTasks = Array.from({ length: 100 }, (_, index) =>
        broker.append({
          projectId,
          streamId: stream.id,
          records: [
            {
              name: "workflow.run.queued",
              key: `workflow:run-${index}`,
              payload: {
                workflowId: "workflow",
                runId: `run-${index}`,
                queuedAt: new Date().toISOString(),
                source: { type: "manual" },
              },
            },
          ],
        })
      )
      const readTasks = Array.from({ length: 50 }, () =>
        broker.read({ projectId, streamId: stream.id, limit: 25 })
      )

      const results = await Promise.all([...appendTasks, ...readTasks])
      expect(results.slice(0, appendTasks.length).flat()).toHaveLength(100)

      const retained = await broker.read({ projectId, streamId: stream.id, limit: 200 })
      expect(retained).toHaveLength(100)
    } finally {
      await cleanup()
    }
  })

  test("deduplicates records inside a bulk append before retention trims them", async () => {
    const { broker, projectId, cleanup } = createTestBroker()
    const stream = { id: "__bulk_dedupe_retained", retention: { maxRecords: 1 } }
    try {
      await broker.ensureStream({ projectId, stream })
      const [first, duplicate, newest] = await broker.append({
        projectId,
        streamId: stream.id,
        records: [
          { payload: { id: "old" }, idempotencyKey: "same" },
          { payload: { id: "ignored" }, idempotencyKey: "same" },
          { payload: { id: "new" }, idempotencyKey: "new" },
        ],
      })

      expect(duplicate?.cursor).toBe(first?.cursor)
      expect(duplicate?.payload).toEqual({ id: "old" })
      expect(newest?.payload).toEqual({ id: "new" })
      expect(
        (await broker.read({ projectId, streamId: stream.id })).map((record) => record.payload)
      ).toEqual([{ id: "new" }])
    } finally {
      await cleanup()
    }
  })

  test("delivers live bulk append records before maxRecords retention trims them", async () => {
    const { broker, projectId, cleanup } = createTestBroker()
    const stream = { id: "__live_bulk_retained", retention: { maxRecords: 1 } }
    const received: string[] = []
    let unsubscribe: (() => void) | undefined

    try {
      await broker.ensureStream({ projectId, stream })
      unsubscribe = await broker.subscribe({ projectId, streamId: stream.id }, (records) => {
        received.push(...records.map((record) => String(record.payload)))
      })
      await Bun.sleep(150)

      await broker.append({
        projectId,
        streamId: stream.id,
        records: [{ payload: "one" }, { payload: "two" }, { payload: "three" }],
      })

      await waitUntil(() => received.length === 3, 5_000)
      expect(received).toEqual(["one", "two", "three"])
      expect(
        (await broker.read({ projectId, streamId: stream.id })).map((record) => record.payload)
      ).toEqual(["three"])
    } finally {
      unsubscribe?.()
      await cleanup()
    }
  })

  test("enforces maxRecords retained reads before physical trim completes", async () => {
    const { broker, projectId, cleanup } = createTestBroker()
    const brokerWithTrimDisabled = broker as unknown as { trimRetention: () => Promise<void> }
    brokerWithTrimDisabled.trimRetention = async () => {}
    const stream = { id: "__logical_bulk_retained", retention: { maxRecords: 1 } }
    const received: string[] = []
    let unsubscribe: (() => void) | undefined

    try {
      await broker.ensureStream({ projectId, stream })
      const [first] = await broker.append({
        projectId,
        streamId: stream.id,
        records: [{ payload: "one" }, { payload: "two" }, { payload: "three" }],
      })

      expect(
        (await broker.read({ projectId, streamId: stream.id })).map((record) => record.payload)
      ).toEqual(["three"])
      await expect(
        broker.read({ projectId, streamId: stream.id, afterCursor: first?.cursor })
      ).rejects.toThrow("outside the retained range")

      unsubscribe = await broker.subscribe(
        { projectId, streamId: stream.id, from: "earliest" },
        (records) => {
          received.push(...records.map((record) => String(record.payload)))
        }
      )
      await waitUntil(() => received.length === 1, 5_000)
      expect(received).toEqual(["three"])
    } finally {
      unsubscribe?.()
      await cleanup()
    }
  })

  test("close drains active subscriptions and rejects later operations", async () => {
    const { broker, projectId } = createTestBroker()
    const stream = { id: "__events" }
    const received: unknown[] = []

    await broker.ensureStream({ projectId, stream })
    await broker.subscribe({ projectId, streamId: stream.id }, (records) => {
      received.push(...records.map((record) => record.payload))
    })
    await Bun.sleep(150)

    await broker.append({
      projectId,
      streamId: stream.id,
      records: [{ name: "object.upserted", payload: { id: "room-before-close" } }],
    })
    await waitUntil(() => received.length === 1, 5_000)

    await broker.close()
    await expect(broker.close()).resolves.toBeUndefined()
    await expect(
      broker.append({
        projectId,
        streamId: stream.id,
        records: [{ name: "object.upserted", payload: { id: "room-after-close" } }],
      })
    ).rejects.toThrow("broker has been closed")

    expect(received).toEqual([{ id: "room-before-close" }])
  })

  test("close rejects operations that have not enqueued their command yet", async () => {
    const { broker, projectId } = createTestBroker()
    const stream = { id: "__close_race" }
    await broker.ensureStream({ projectId, stream })

    const manager = (
      broker as unknown as {
        streamManager: {
          requireStream(projectId: string, streamId: string): Promise<unknown>
        }
      }
    ).streamManager
    const originalRequireStream = manager.requireStream.bind(manager)
    let releaseRequireStream!: () => void
    const requireStreamGate = new Promise<void>((resolve) => {
      releaseRequireStream = resolve
    })
    const blockedInRequireStream = new Promise<void>((resolve) => {
      manager.requireStream = async (projectId, streamId) => {
        const ensured = await originalRequireStream(projectId, streamId)
        resolve()
        await requireStreamGate
        return ensured
      }
    })

    const append = broker.append({
      projectId,
      streamId: stream.id,
      records: [{ name: "object.upserted", payload: { id: "room-after-close" } }],
    })

    await blockedInRequireStream
    await broker.close()
    releaseRequireStream()

    await expect(append).rejects.toThrow("closed")
  })

  test("close rejects subscriptions that are still resolving their starting cursor", async () => {
    const { broker, projectId } = createTestBroker()
    const stream = { id: "__subscribe_close_race" }
    await broker.ensureStream({ projectId, stream })

    const brokerInternals = broker as unknown as {
      subscriptionStartCursor(client: unknown, ensured: unknown): Promise<string>
    }
    const originalSubscriptionStartCursor = brokerInternals.subscriptionStartCursor.bind(broker)
    let releaseSubscriptionStartCursor!: () => void
    const subscriptionStartCursorGate = new Promise<void>((resolve) => {
      releaseSubscriptionStartCursor = resolve
    })
    const blockedInSubscriptionStartCursor = new Promise<void>((resolve) => {
      brokerInternals.subscriptionStartCursor = async (client, ensured) => {
        resolve()
        await subscriptionStartCursorGate
        return originalSubscriptionStartCursor(client, ensured)
      }
    })

    const subscribe = broker.subscribe({ projectId, streamId: stream.id }, () => {})

    await blockedInSubscriptionStartCursor
    await broker.close()
    releaseSubscriptionStartCursor()

    await expect(subscribe).rejects.toThrow()
  })

  test("allows reads after the latest trimmed cursor boundary", async () => {
    const { broker, projectId, cleanup } = createTestBroker()
    const stream = { id: "__retained", retention: { maxRecords: 2 } }
    try {
      await broker.ensureStream({ projectId, stream })
      const [first] = await broker.append({
        projectId,
        streamId: stream.id,
        records: [{ payload: "one" }],
      })
      await broker.append({
        projectId,
        streamId: stream.id,
        records: [{ payload: "two" }, { payload: "three" }],
      })

      const records = await broker.read({
        projectId,
        streamId: stream.id,
        afterCursor: first?.cursor,
      })

      expect(records.map((record) => record.payload)).toEqual(["two", "three"])
    } finally {
      await cleanup()
    }
  })

  test("enforces maxAgeMs retention on idle retained reads", async () => {
    const { broker, projectId, cleanup } = createTestBroker()
    const stream = { id: "__age_retained_idle", retention: { maxAgeMs: 100 } }
    try {
      await broker.ensureStream({ projectId, stream })
      const [old] = await broker.append({
        projectId,
        streamId: stream.id,
        records: [{ payload: "old" }],
      })

      await Bun.sleep(250)

      await expect(
        broker.read({
          projectId,
          streamId: stream.id,
          afterCursor: "0-0",
        })
      ).rejects.toThrow("outside the retained range")
      expect(
        await broker.read({
          projectId,
          streamId: stream.id,
          afterCursor: old?.cursor,
        })
      ).toEqual([])
      expect(await broker.read({ projectId, streamId: stream.id })).toEqual([])
    } finally {
      await cleanup()
    }
  })

  test("enforces maxAgeMs retention before retained subscription replay", async () => {
    const { broker, projectId, cleanup } = createTestBroker()
    const stream = { id: "__age_retained_replay", retention: { maxAgeMs: 100 } }
    const received: unknown[] = []

    try {
      await broker.ensureStream({ projectId, stream })
      await broker.append({
        projectId,
        streamId: stream.id,
        records: [{ payload: "old" }],
      })

      await Bun.sleep(250)

      await expect(
        broker.subscribe({ projectId, streamId: stream.id, afterCursor: "0-0" }, () => undefined)
      ).rejects.toThrow("outside the retained range")

      const unsubscribe = await broker.subscribe(
        { projectId, streamId: stream.id, from: "earliest" },
        (records) => {
          received.push(...records.map((record) => record.payload))
        }
      )
      await Bun.sleep(250)
      unsubscribe()

      expect(received).toEqual([])
    } finally {
      await cleanup()
    }
  })
})

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await Bun.sleep(25)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}
