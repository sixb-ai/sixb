import { describe, expect, test } from "bun:test"
import { BrokerCursorExpiredError, type BrokerRecord } from "@sixb/core/broker"
import { RedisClient } from "bun"
import { type RedisStreamKeys, streamKeysFor } from "../src/keys"
import { createTestBroker, requireRedisUrl } from "./helpers"

// An agent run's stream is written while the run lasts and never again. Age retention used to run
// only when a command touched the stream, so a finished run kept every record and key until someone
// read it again. These tests stand in for Redis expiring the keys by deleting them, so nothing
// waits on the clock. To see the first test fail, drop the `PEXPIRE` calls from
// `expire_idle_stream` in src/scripts.ts.

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const run = { id: "agents.runs.run_1", retention: { maxAgeMs: TWO_HOURS_MS, maxRecords: 5_000 } }

describe("RedisBroker idle stream expiry", () => {
  test("expires an idle stream's keys once its records leave retention", async () => {
    await withBroker(async ({ broker, projectId, keys, redis }) => {
      await broker.ensureStream({ projectId, stream: run })
      await broker.append({
        projectId,
        streamId: run.id,
        records: [{ payload: "started" }],
      })

      const streamTtl = await pttl(redis, keys.streamKey)
      const metaTtl = await pttl(redis, keys.metaKey)
      expect(streamTtl).toBeGreaterThan(TWO_HOURS_MS - 1_000)
      expect(streamTtl).toBeLessThanOrEqual(TWO_HOURS_MS + 60_000)
      // Metadata outlives the records so a returning reader still learns its cursor expired.
      expect(metaTtl).toBeGreaterThan(streamTtl)
      expect(metaTtl).toBeLessThanOrEqual(TWO_HOURS_MS + 60_000 + 24 * 60 * 60 * 1000)

      // Every append pushes the expiry out again.
      await redis.send("PEXPIRE", [keys.streamKey, "5000"])
      await redis.send("PEXPIRE", [keys.metaKey, "5000"])
      await broker.append({ projectId, streamId: run.id, records: [{ payload: "finished" }] })
      expect(await pttl(redis, keys.streamKey)).toBeGreaterThan(TWO_HOURS_MS - 1_000)
      expect(await pttl(redis, keys.metaKey)).toBeGreaterThan(TWO_HOURS_MS - 1_000)
    })
  })

  test("never expires a stream without age retention", async () => {
    await withBroker(async ({ broker, projectId, prefix, redis }) => {
      const stream = { id: "__counted", retention: { maxRecords: 10 } }
      const keys = streamKeysFor(prefix, projectId, stream.id)
      await broker.ensureStream({ projectId, stream })
      await broker.append({ projectId, streamId: stream.id, records: [{ payload: "kept" }] })
      await broker.read({ projectId, streamId: stream.id })

      expect(await pttl(redis, keys.streamKey)).toBe(-1)
      expect(await pttl(redis, keys.metaKey)).toBe(-1)
    })
  })

  test("reads an expired stream as a missing one, and writes bring it back", async () => {
    await withBroker(async ({ broker, projectId, keys, redis }) => {
      await broker.ensureStream({ projectId, stream: run })
      await broker.append({ projectId, streamId: run.id, records: [{ payload: "old" }] })
      // The broker has the stream cached as ensured; Redis has expired both keys.
      await redis.del(keys.streamKey, keys.metaKey)

      expect(await broker.read({ projectId, streamId: run.id })).toEqual({
        records: [],
        cursor: undefined,
        hasMore: false,
      })
      expect((await broker.tail({ projectId, streamId: run.id })).records).toEqual([])
      expect(await broker.latestCursor({ projectId, streamId: run.id })).toBeUndefined()

      const [appended] = await broker.append({
        projectId,
        streamId: run.id,
        records: [{ payload: "after" }],
      })
      expect((await broker.read({ projectId, streamId: run.id })).records).toEqual([appended!])
      expect(await redis.hget(keys.metaKey, "maxAgeMs")).toBe(String(TWO_HOURS_MS))
      expect(await pttl(redis, keys.metaKey)).toBeGreaterThan(0)

      await redis.del(keys.streamKey, keys.metaKey)
      const { promise: delivered, resolve } = Promise.withResolvers<readonly BrokerRecord[]>()
      const unsubscribe = await broker.subscribe(
        { projectId, streamId: run.id, from: "earliest" },
        resolve
      )
      try {
        await broker.append({ projectId, streamId: run.id, records: [{ payload: "live" }] })
        // Delivery is ordered, so a record from before the expiry would arrive first.
        expect((await delivered).map((record) => record.payload)).toEqual(["live"])
      } finally {
        unsubscribe()
      }
    })
  })

  test("rejects cursors from before the expiry while the metadata outlives the records", async () => {
    await withBroker(async ({ broker, projectId, keys, redis }) => {
      await broker.ensureStream({ projectId, stream: run })
      const [, last] = await broker.append({
        projectId,
        streamId: run.id,
        records: [{ payload: "one" }, { payload: "two" }],
      })
      await redis.del(keys.streamKey)

      const error = await broker
        .read({ projectId, streamId: run.id, afterCursor: "0-0" })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(BrokerCursorExpiredError)
      expect(
        (await broker.read({ projectId, streamId: run.id, afterCursor: last!.cursor })).records
      ).toEqual([])
      expect(await broker.latestCursor({ projectId, streamId: run.id })).toBeUndefined()
    })
  })

  test("counts no bytes for the records an expired stream key took", async () => {
    await withBroker(async ({ broker, projectId, prefix, redis }) => {
      const stream = { id: "__bytes", retention: { maxAgeMs: TWO_HOURS_MS, maxBytes: 1_024 } }
      const keys = streamKeysFor(prefix, projectId, stream.id)
      await broker.ensureStream({ projectId, stream })
      const [old] = await broker.append({
        projectId,
        streamId: stream.id,
        records: [{ payload: "x".repeat(900) }],
      })
      await redis.del(keys.streamKey)

      const [next] = await broker.append({
        projectId,
        streamId: stream.id,
        records: [{ payload: "y".repeat(600) }],
      })
      expect((await broker.read({ projectId, streamId: stream.id })).records).toEqual([next!])
      expect(
        (await broker.read({ projectId, streamId: stream.id, afterCursor: old!.cursor })).records
      ).toEqual([next!])
    })
  })

  test("expires streams written before expiry existed when they are next read", async () => {
    await withBroker(async ({ broker, projectId, prefix, redis }) => {
      await broker.ensureStream({ projectId, stream: run })
      await broker.append({ projectId, streamId: run.id, records: [{ payload: "recent" }] })
      const keys = streamKeysFor(prefix, projectId, run.id)
      await redis.persist(keys.streamKey)
      await redis.persist(keys.metaKey)

      await broker.read({ projectId, streamId: run.id })
      expect(await pttl(redis, keys.streamKey)).toBeGreaterThan(TWO_HOURS_MS - 1_000)
      expect(await pttl(redis, keys.metaKey)).toBeGreaterThan(TWO_HOURS_MS - 1_000)

      // A run that finished long ago: every record and the grace period are behind it.
      const stale = { ...run, id: "agents.runs.run_stale" }
      const staleKeys = streamKeysFor(prefix, projectId, stale.id)
      await broker.ensureStream({ projectId, stream: stale })
      await redis.persist(staleKeys.metaKey)
      await redis.send("XADD", [staleKeys.streamKey, "1000-0", "body", "{}"])
      await redis.hset(staleKeys.metaKey, { lastId: "1000-0", retainedBytes: "2" })

      expect((await broker.read({ projectId, streamId: stale.id })).records).toEqual([])
      expect(await redis.exists(staleKeys.streamKey)).toBe(false)
      expect(await redis.exists(staleKeys.metaKey)).toBe(false)
    })
  })
})

async function withBroker(
  body: (context: {
    broker: ReturnType<typeof createTestBroker>["broker"]
    projectId: string
    prefix: string
    keys: RedisStreamKeys
    redis: RedisClient
  }) => Promise<void>
): Promise<void> {
  const { broker, projectId, prefix, cleanup } = createTestBroker()
  const redis = new RedisClient(requireRedisUrl())
  try {
    await body({ broker, projectId, prefix, keys: streamKeysFor(prefix, projectId, run.id), redis })
  } finally {
    redis.close()
    await cleanup()
  }
}

async function pttl(redis: RedisClient, key: string): Promise<number> {
  return Number(await redis.send("PTTL", [key]))
}
