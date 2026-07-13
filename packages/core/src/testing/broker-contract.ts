import { describe, expect, test } from "bun:test"
import { BrokerError } from "../broker/errors"
import type {
  Broker,
  BrokerRecord,
  BrokerRecordInput,
  BrokerStreamDefinition,
} from "../broker/types"
import type { JsonValue } from "../json"

export interface BrokerContractSuiteOptions<TBroker extends Broker = Broker> {
  /** Factory that produces a fresh `Broker` instance for each test case. */
  readonly createBroker: () => TBroker | Promise<TBroker>
  /** Optional cleanup invoked after every test case. */
  readonly teardown?: (broker: TBroker) => void | Promise<void>
  /**
   * Retention age used by the maxAgeMs assertion. Defaults to 20ms.
   * Providers with coarse server-side retention can increase this in their own suite.
   */
  readonly maxAgeMs?: number
  /**
   * Time to wait for maxAgeMs retention to expire. Defaults to `maxAgeMs + 20`.
   */
  readonly maxAgeWaitMs?: number
  /**
   * Time to wait after registering a live subscription before appending records.
   * Defaults to 0 for synchronous providers.
   */
  readonly subscriptionSetupMs?: number
  /**
   * Time to wait for asynchronous subscription delivery. Defaults to 200ms.
   */
  readonly subscriptionDeliveryTimeoutMs?: number
  /**
   * Poll interval while waiting for asynchronous subscription delivery. Defaults to 10ms.
   */
  readonly subscriptionPollIntervalMs?: number
}

const eventsStream: BrokerStreamDefinition = { id: "__events" }
const retainedStream: BrokerStreamDefinition = { id: "__retained", retention: { maxRecords: 2 } }

/**
 * Runs the shared `Broker` contract against any provider.
 *
 * The contract intentionally stays small: append records, read retained records
 * by exclusive cursor, subscribe to retained/live streams, and apply portable
 * retention. Provider-specific administration and durable consumer identity
 * are outside the V1 broker surface.
 */
export function runBrokerContractSuite<TBroker extends Broker>(
  label: string,
  options: BrokerContractSuiteOptions<TBroker>
): void {
  const maxAgeMs = options.maxAgeMs ?? 20
  const maxAgeWaitMs = options.maxAgeWaitMs ?? maxAgeMs + 20
  const subscriptionSetupMs = options.subscriptionSetupMs ?? 0
  const subscriptionDeliveryTimeoutMs = options.subscriptionDeliveryTimeoutMs ?? 200
  const subscriptionPollIntervalMs = options.subscriptionPollIntervalMs ?? 10

  const withBroker = async (body: (broker: TBroker) => Promise<void>): Promise<void> => {
    const broker = await options.createBroker()
    try {
      await body(broker)
    } finally {
      await options.teardown?.(broker)
    }
  }

  describe(label, () => {
    describe("append", () => {
      test("returns stored records with cursors and timestamps", async () => {
        await withBroker(async (broker) => {
          const before = Date.now()

          const records = await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [
              {
                name: "test.record",
                key: "Room:room-1",
                payload: { objectTypeId: "Room", primaryId: "room-1" },
              },
            ],
          })

          expect(records).toHaveLength(1)
          expect(records[0]).toMatchObject({
            streamId: eventsStream.id,
            name: "test.record",
            key: "Room:room-1",
            payload: { objectTypeId: "Room", primaryId: "room-1" },
          })
          expect(records[0]?.cursor).toBeTruthy()
          expect(Date.parse(records[0]!.publishedAt)).toBeGreaterThanOrEqual(before)
        })
      })

      test("snapshots appended payloads", async () => {
        await withBroker(async (broker) => {
          const payload = { nested: { value: "before" } }

          const [record] = await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [{ payload }],
          })
          payload.nested.value = "after"

          expect(record?.payload).toEqual({ nested: { value: "before" } })
          const [readBack] = await readRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
          })
          expect(readBack?.payload).toEqual({ nested: { value: "before" } })
        })
      })

      test("returns empty array for empty appends", async () => {
        await withBroker(async (broker) => {
          const records = await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [],
          })

          expect(records).toEqual([])
        })
      })

      test("rejects empty projectId and stream id", async () => {
        await withBroker(async (broker) => {
          await expect(
            appendRecords(broker, {
              projectId: "  ",
              stream: eventsStream,
              records: [{ payload: { ok: true } }],
            })
          ).rejects.toBeInstanceOf(BrokerError)

          await expect(
            appendRecords(broker, {
              projectId: "project-a",
              stream: { id: "  " },
              records: [{ payload: { ok: true } }],
            })
          ).rejects.toBeInstanceOf(BrokerError)
        })
      })

      test("rejects payloads that are not JSON values", async () => {
        await withBroker(async (broker) => {
          await expect(
            appendRecords(broker, {
              projectId: "project-a",
              stream: eventsStream,
              records: [
                {
                  payload: {
                    observedAt: new Date("2026-01-01T00:00:00.000Z"),
                  } as unknown as JsonValue,
                },
              ],
            })
          ).rejects.toBeInstanceOf(BrokerError)

          await expect(
            appendRecords(broker, {
              projectId: "project-a",
              stream: eventsStream,
              records: [{ payload: { value: Number.NaN } as unknown as JsonValue }],
            })
          ).rejects.toBeInstanceOf(BrokerError)
        })
      })

      test("requires streams to be ensured before appending records", async () => {
        await withBroker(async (broker) => {
          await expect(
            broker.append({
              projectId: "project-a",
              streamId: "missing",
              records: [{ payload: "one" }],
            })
          ).rejects.toBeInstanceOf(BrokerError)
        })
      })
    })

    describe("read", () => {
      test("reads records after an exclusive cursor", async () => {
        await withBroker(async (broker) => {
          const [first] = await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [
              { name: "one", payload: { value: 1 } },
              { name: "two", payload: { value: 2 } },
              { name: "three", payload: { value: 3 } },
            ],
          })

          const records = await readRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            afterCursor: first?.cursor,
          })

          expect(records.map((record) => record.name)).toEqual(["two", "three"])
        })
      })

      test("limits matching records after applying name filters", async () => {
        await withBroker(async (broker) => {
          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [
              { name: "test.record", payload: { id: "room-1" } },
              { name: "telemetry.appended", payload: { id: "temp-1" } },
              { name: "test.record", payload: { id: "room-2" } },
            ],
          })

          const records = await readRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            names: ["test.record"],
            limit: 2,
          })

          expect(records.map((record) => record.payload)).toEqual([
            { id: "room-1" },
            { id: "room-2" },
          ])
        })
      })

      test("returns empty array for missing streams and non-positive limits", async () => {
        await withBroker(async (broker) => {
          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [{ name: "test.record", payload: { id: "room-1" } }],
          })

          expect(
            await broker.read({
              projectId: "project-a",
              streamId: "missing",
            })
          ).toEqual({ records: [], cursor: undefined, hasMore: false })
          expect(
            await readRecords(broker, { projectId: "project-a", stream: eventsStream, limit: 0 })
          ).toEqual([])
          expect(
            await readRecords(broker, { projectId: "project-a", stream: eventsStream, limit: -1 })
          ).toEqual([])
        })
      })

      test("isolates projects and streams", async () => {
        await withBroker(async (broker) => {
          await appendRecords(broker, {
            projectId: "project-a",
            stream: { id: "stream-a" },
            records: [{ payload: { value: "a" } }],
          })
          await appendRecords(broker, {
            projectId: "project-b",
            stream: { id: "stream-a" },
            records: [{ payload: { value: "b" } }],
          })
          await appendRecords(broker, {
            projectId: "project-a",
            stream: { id: "stream-b" },
            records: [{ payload: { value: "c" } }],
          })

          expect(
            await payloads(
              readRecords(broker, { projectId: "project-a", stream: { id: "stream-a" } })
            )
          ).toEqual([{ value: "a" }])
          expect(
            await payloads(
              readRecords(broker, { projectId: "project-b", stream: { id: "stream-a" } })
            )
          ).toEqual([{ value: "b" }])
          expect(
            await payloads(
              readRecords(broker, { projectId: "project-a", stream: { id: "stream-b" } })
            )
          ).toEqual([{ value: "c" }])
        })
      })

      test("advances the page cursor when filters match no records", async () => {
        await withBroker(async (broker) => {
          const appended = await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [
              { name: "one", payload: 1 },
              { name: "two", payload: 2 },
            ],
          })

          const page = await broker.read({
            projectId: "project-a",
            streamId: eventsStream.id,
            names: ["missing"],
            limit: 1,
          })

          expect(page.records).toEqual([])
          expect(page.cursor).toBe(appended.at(-1)?.cursor)
          expect(page.hasMore).toBe(false)
        })
      })

      test("filters by record key before applying the page limit", async () => {
        await withBroker(async (broker) => {
          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [
              { key: "sync:a", payload: "a1" },
              { key: "sync:b", payload: "b" },
              { key: "sync:a", payload: "a2" },
            ],
          })

          const page = await broker.read({
            projectId: "project-a",
            streamId: eventsStream.id,
            keys: ["sync:a"],
            limit: 2,
          })
          expect(page.records.map((record) => record.payload)).toEqual(["a1", "a2"])
        })
      })

      test("reports no forward page when only filtered-out records remain", async () => {
        await withBroker(async (broker) => {
          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [
              { key: "target", payload: "match" },
              { key: "other", payload: "filtered-one" },
              { key: "other", payload: "filtered-two" },
            ],
          })

          const page = await broker.read({
            projectId: "project-a",
            streamId: eventsStream.id,
            keys: ["target"],
            limit: 1,
          })
          expect(page.records.map((record) => record.payload)).toEqual(["match"])
          expect(page.hasMore).toBe(false)
        })
      })

      test("reports no backward page when only filtered-out records remain", async () => {
        await withBroker(async (broker) => {
          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [
              { key: "other", payload: "filtered-one" },
              { key: "other", payload: "filtered-two" },
              { key: "target", payload: "match" },
            ],
          })

          const page = await broker.tail({
            projectId: "project-a",
            streamId: eventsStream.id,
            keys: ["target"],
            limit: 1,
          })
          expect(page.records.map((record) => record.payload)).toEqual(["match"])
          expect(page.hasMore).toBe(false)
        })
      })

      test("tails recent records and paginates toward older history", async () => {
        await withBroker(async (broker) => {
          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [1, 2, 3, 4, 5].map((payload) => ({ payload })),
          })

          const recent = await broker.tail({
            projectId: "project-a",
            streamId: eventsStream.id,
            limit: 2,
          })
          expect(recent.records.map((record) => record.payload)).toEqual([4, 5])
          expect(recent.hasMore).toBe(true)

          const older = await broker.tail({
            projectId: "project-a",
            streamId: eventsStream.id,
            beforeCursor: recent.cursor,
            limit: 2,
          })
          expect(older.records.map((record) => record.payload)).toEqual([2, 3])
          expect(older.hasMore).toBe(true)
        })
      })
    })

    describe("latestCursor", () => {
      test("returns undefined for missing and empty streams", async () => {
        await withBroker(async (broker) => {
          expect(
            await broker.latestCursor({ projectId: "project-a", streamId: "missing" })
          ).toBeUndefined()

          await broker.ensureStream({ projectId: "project-a", stream: eventsStream })
          expect(
            await broker.latestCursor({ projectId: "project-a", streamId: eventsStream.id })
          ).toBeUndefined()
        })
      })

      test("returns the newest retained record cursor", async () => {
        await withBroker(async (broker) => {
          const records = await appendRecords(broker, {
            projectId: "project-a",
            stream: retainedStream,
            records: [{ payload: "one" }, { payload: "two" }, { payload: "three" }],
          })

          expect(
            await broker.latestCursor({ projectId: "project-a", streamId: retainedStream.id })
          ).toBe(records.at(-1)?.cursor)
        })
      })
    })

    describe("subscribe", () => {
      test("requires streams to be ensured before subscribing", async () => {
        await withBroker(async (broker) => {
          await expect(
            broker.subscribe({ projectId: "project-a", streamId: "missing" }, () => {})
          ).rejects.toBeInstanceOf(BrokerError)
        })
      })

      test("defaults to latest and receives only new records", async () => {
        await withBroker(async (broker) => {
          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [{ name: "before", payload: { value: "before" } }],
          })

          const received: string[] = []
          await subscribeRecords(
            broker,
            { projectId: "project-a", stream: eventsStream },
            (records) => {
              received.push(...records.map((record) => String(record.payload)))
            }
          )
          if (subscriptionSetupMs > 0) {
            await Bun.sleep(subscriptionSetupMs)
          }

          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [{ name: "after", payload: "after" }],
          })

          await waitUntil(() => received.length === 1, {
            timeoutMs: subscriptionDeliveryTimeoutMs,
            intervalMs: subscriptionPollIntervalMs,
            message: "Broker subscription did not receive the appended record",
          })
          expect(received).toEqual(["after"])
        })
      })

      test("can subscribe from earliest retained record", async () => {
        await withBroker(async (broker) => {
          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [
              { name: "one", payload: "one" },
              { name: "two", payload: "two" },
            ],
          })

          const received: string[] = []
          await subscribeRecords(
            broker,
            { projectId: "project-a", stream: eventsStream, from: "earliest" },
            (records) => {
              received.push(...records.map((record) => String(record.payload)))
            }
          )
          if (subscriptionSetupMs > 0) {
            await Bun.sleep(subscriptionSetupMs)
          }

          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [{ name: "three", payload: "three" }],
          })

          await waitUntil(() => received.length === 3, {
            timeoutMs: subscriptionDeliveryTimeoutMs,
            intervalMs: subscriptionPollIntervalMs,
            message: "Broker subscription did not receive retained plus live records",
          })
          expect(received).toEqual(["one", "two", "three"])
        })
      })

      test("can subscribe after a cursor and filter by name and key", async () => {
        await withBroker(async (broker) => {
          const [first] = await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [
              { name: "test.record", key: "other", payload: "one" },
              { name: "telemetry.appended", key: "target", payload: "two" },
              { name: "test.record", key: "target", payload: "three" },
            ],
          })

          const received: string[] = []
          await subscribeRecords(
            broker,
            {
              projectId: "project-a",
              stream: eventsStream,
              afterCursor: first?.cursor,
              names: ["test.record"],
              keys: ["target"],
            },
            (records) => {
              received.push(...records.map((record) => String(record.payload)))
            }
          )

          await waitUntil(() => received.length === 1, {
            timeoutMs: subscriptionDeliveryTimeoutMs,
            intervalMs: subscriptionPollIntervalMs,
            message: "Broker subscription did not replay matching records after cursor",
          })
          expect(received).toEqual(["three"])
        })
      })

      test("unsubscribe stops delivery", async () => {
        await withBroker(async (broker) => {
          const received: string[] = []
          const unsubscribe = await subscribeRecords(
            broker,
            { projectId: "project-a", stream: eventsStream },
            (records) => {
              received.push(...records.map((record) => String(record.payload)))
            }
          )
          if (subscriptionSetupMs > 0) {
            await Bun.sleep(subscriptionSetupMs)
          }

          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [{ payload: "one" }],
          })

          await waitUntil(() => received.length === 1, {
            timeoutMs: subscriptionDeliveryTimeoutMs,
            intervalMs: subscriptionPollIntervalMs,
            message: "Broker subscription did not receive the first record before unsubscribe",
          })

          unsubscribe()
          await appendRecords(broker, {
            projectId: "project-a",
            stream: eventsStream,
            records: [{ payload: "two" }],
          })
          await Bun.sleep(Math.min(250, subscriptionDeliveryTimeoutMs))

          expect(received).toEqual(["one"])
        })
      })

      test("swallows handler errors", async () => {
        await withBroker(async (broker) => {
          const received: string[] = []
          await subscribeRecords(broker, { projectId: "project-a", stream: eventsStream }, () => {
            throw new Error("subscriber failed")
          })
          await subscribeRecords(
            broker,
            { projectId: "project-a", stream: eventsStream },
            (records) => {
              received.push(...records.map((record) => String(record.payload)))
            }
          )
          if (subscriptionSetupMs > 0) {
            await Bun.sleep(subscriptionSetupMs)
          }

          await expect(
            appendRecords(broker, {
              projectId: "project-a",
              stream: eventsStream,
              records: [{ payload: "one" }],
            })
          ).resolves.toHaveLength(1)
          await waitUntil(() => received.length === 1, {
            timeoutMs: subscriptionDeliveryTimeoutMs,
            intervalMs: subscriptionPollIntervalMs,
            message: "Broker subscription delivery stopped after another handler threw",
          })
          expect(received).toEqual(["one"])
        })
      })
    })

    describe("retention", () => {
      test("bounds retained history by bytes", async () => {
        await withBroker(async (broker) => {
          const stream = { id: "__byte_retained", retention: { maxBytes: 1_024 } }
          await broker.ensureStream({ projectId: "project-a", stream })

          await broker.append({
            projectId: "project-a",
            streamId: stream.id,
            records: ["one", "two", "three"].map((label) => ({
              name: label,
              payload: { label, body: "x".repeat(600) },
            })),
          })

          const records = await broker.read({
            projectId: "project-a",
            streamId: stream.id,
          })
          expect(records.records.length).toBeGreaterThan(0)
          expect(records.records.length).toBeLessThan(3)
          expect(records.records.at(-1)?.name).toBe("three")
        })
      })

      test("retains only the latest maxRecords", async () => {
        await withBroker(async (broker) => {
          await appendRecords(broker, {
            projectId: "project-a",
            stream: retainedStream,
            records: [{ payload: "one" }, { payload: "two" }, { payload: "three" }],
          })

          const records = await readRecords(broker, {
            projectId: "project-a",
            stream: retainedStream,
          })

          expect(records.map((record) => record.payload)).toEqual(["two", "three"])
        })
      })

      test("rejects reads when the requested cursor predates the retained range", async () => {
        await withBroker(async (broker) => {
          const [first] = await appendRecords(broker, {
            projectId: "project-a",
            stream: retainedStream,
            records: [
              { payload: "one" },
              { payload: "two" },
              { payload: "three" },
              { payload: "four" },
            ],
          })

          await expect(
            readRecords(broker, {
              projectId: "project-a",
              stream: retainedStream,
              afterCursor: first?.cursor,
            })
          ).rejects.toBeInstanceOf(BrokerError)

          await expect(
            broker.tail({
              projectId: "project-a",
              streamId: retainedStream.id,
              beforeCursor: first?.cursor,
            })
          ).rejects.toBeInstanceOf(BrokerError)
        })
      })

      test("retains only records within maxAgeMs", async () => {
        await withBroker(async (broker) => {
          const stream = { id: "__age_retained", retention: { maxAgeMs } }
          await appendRecords(broker, {
            projectId: "project-a",
            stream,
            records: [{ payload: "old" }],
          })

          await Bun.sleep(maxAgeWaitMs)

          await appendRecords(broker, {
            projectId: "project-a",
            stream,
            records: [{ payload: "new" }],
          })

          const records = await readRecords(broker, { projectId: "project-a", stream })

          expect(records.map((record) => record.payload)).toEqual(["new"])
        })
      })
    })
  })
}

async function payloads(records: Promise<readonly BrokerRecord[]>): Promise<readonly unknown[]> {
  return (await records).map((record) => record.payload)
}

async function appendRecords(
  broker: Broker,
  params: {
    projectId: string
    stream: BrokerStreamDefinition
    records: readonly BrokerRecordInput[]
  }
): Promise<readonly BrokerRecord[]> {
  await broker.ensureStream({ projectId: params.projectId, stream: params.stream })
  return broker.append({
    projectId: params.projectId,
    streamId: params.stream.id,
    records: params.records,
  })
}

async function readRecords(
  broker: Broker,
  params: {
    projectId: string
    stream: BrokerStreamDefinition
    afterCursor?: string
    limit?: number
    names?: readonly string[]
    keys?: readonly string[]
  }
): Promise<readonly BrokerRecord[]> {
  await broker.ensureStream({ projectId: params.projectId, stream: params.stream })
  return (
    await broker.read({
      projectId: params.projectId,
      streamId: params.stream.id,
      afterCursor: params.afterCursor,
      limit: params.limit,
      names: params.names,
      keys: params.keys,
    })
  ).records
}

async function subscribeRecords(
  broker: Broker,
  params: {
    projectId: string
    stream: BrokerStreamDefinition
    from?: "latest" | "earliest"
    afterCursor?: string
    names?: readonly string[]
    keys?: readonly string[]
  },
  handler: (records: readonly BrokerRecord[]) => void
): Promise<() => void> {
  await broker.ensureStream({ projectId: params.projectId, stream: params.stream })
  return broker.subscribe(
    {
      projectId: params.projectId,
      streamId: params.stream.id,
      from: params.from,
      afterCursor: params.afterCursor,
      names: params.names,
      keys: params.keys,
    },
    handler
  )
}

async function waitUntil(
  predicate: () => boolean,
  options: { timeoutMs: number; intervalMs: number; message: string }
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await Bun.sleep(options.intervalMs)
  }
  throw new Error(`${options.message} within ${options.timeoutMs}ms`)
}
