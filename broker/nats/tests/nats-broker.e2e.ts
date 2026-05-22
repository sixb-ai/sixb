import { describe, expect, test } from "bun:test"
import { runBrokerContractSuite } from "@pario/core/testing"
import { createTestBroker } from "./helpers"

runBrokerContractSuite("NatsBroker", {
  createBroker: async () => createTestBroker().broker,
  teardown: async (broker) => {
    await broker.close()
  },
  maxAgeMs: 1_000,
  maxAgeWaitMs: 1_500,
  subscriptionSetupMs: 500,
  subscriptionDeliveryTimeoutMs: 5_000,
  subscriptionPollIntervalMs: 25,
})

describe("NatsBroker", () => {
  test("deduplicates records by idempotencyKey within the JetStream duplicate window", async () => {
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

  test("close drains active subscriptions and rejects later operations", async () => {
    const { broker, projectId } = createTestBroker()
    const stream = { id: "__events" }
    const received: unknown[] = []

    await broker.ensureStream({ projectId, stream })
    await broker.subscribe({ projectId, streamId: stream.id }, (records) => {
      received.push(...records.map((record) => record.payload))
    })
    await Bun.sleep(500)

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
