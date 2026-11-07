import { describe, expect, test } from "bun:test"
import {
  type DatasetIngestChange,
  type DatasetIngestLease,
  DatasetIngestLeaseLostError,
  type DatasetIngestStorage,
} from "../storage/dataset-ingest"

export interface DatasetIngestStorageContractSuiteOptions<
  TStorage extends DatasetIngestStorage = DatasetIngestStorage,
> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "dataset-ingest-contract"
const datasetId = "crm.people"
const LEASE_MS = 60_000

/**
 * Provider-neutral contract for the inbox of ingested changes: what a delivery stores, how flush
 * requests open and close, and how one lease at a time takes whole deliveries in inbox order.
 */
export function runDatasetIngestStorageContractSuite<TStorage extends DatasetIngestStorage>(
  label: string,
  options: DatasetIngestStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("stores each change as ingest validated it, dates included, in delivery order", () =>
      withStorage(async (storage) => {
        const updatedAt = new Date("2026-09-09T10:00:00.123Z")
        const first = await append(storage, [
          {
            kind: "upsert",
            row: { id: "42", name: "Sam", updatedAt, birthday: new Date("1990-05-01T00:00:00Z") },
          },
          { kind: "delete", key: { id: "9" }, sequence: new Date("2026-09-09T10:01:00.000Z") },
        ])
        const second = await append(storage, [
          { kind: "upsert", row: { id: "43", name: "Ada", updatedAt: "2026-09-09T10:02:00Z" } },
          { kind: "delete", key: { id: "10" }, sequence: "17" },
          { kind: "delete", key: { id: "11" } },
        ])

        expect(first).toMatchObject({ datasetId, changeCount: 2, executionId: "exec-1" })
        expect(first.receivedAt).toBeInstanceOf(Date)

        const lease = await acquire(storage, "owner-a")
        const batch = await storage.takeBatch({ lease, flushId: "flush-1", maxChanges: 100 })
        expect(batch?.deliveries.map((delivery) => delivery.id)).toEqual([first.id, second.id])

        const read = await readAll(storage, lease, "flush-1")
        expect(read.map(({ delivery }) => delivery.id)).toEqual([first.id, second.id])
        expect(read.flatMap(({ changes }) => changes)).toEqual([
          {
            kind: "upsert",
            row: {
              id: "42",
              name: "Sam",
              updatedAt,
              birthday: new Date("1990-05-01T00:00:00Z"),
            },
          },
          { kind: "delete", key: { id: "9" }, sequence: new Date("2026-09-09T10:01:00.000Z") },
          { kind: "upsert", row: { id: "43", name: "Ada", updatedAt: "2026-09-09T10:02:00Z" } },
          { kind: "delete", key: { id: "10" }, sequence: "17" },
          { kind: "delete", key: { id: "11" } },
        ])
      }))

    // A sender that truncates text in the middle of an emoji leaves half a surrogate pair. Reproduce
    // on PostgreSQL: make `changes` jsonb in the migration, which refuses it.
    test("stores a lone surrogate, which is a valid string but not valid Unicode", () =>
      withStorage(async (storage) => {
        const changes: DatasetIngestChange[] = [
          { kind: "upsert", row: { id: "1", name: "caf\ud83d" } },
        ]

        await storage.append(deliveryInput(changes))

        const lease = await acquire(storage, "owner-a")
        await storage.takeBatch({ lease, flushId: "flush-1", maxChanges: 100 })
        const [read] = await readAll(storage, lease, "flush-1")

        expect(read?.changes).toEqual(changes)
      }))

    test("keeps the definition a delivery was validated against, on every way to read it", () =>
      withStorage(async (storage) => {
        await storage.append({ ...deliveryInput([upsert("1")]), definitionHash: "definition-v2" })

        const dead = await acquire(storage, "owner-a", 0)
        const batch = await storage.takeBatch({ lease: dead, flushId: "flush-1", maxChanges: 100 })
        expect(batch?.deliveries[0]?.definitionHash).toBe("definition-v2")

        const lease = await acquire(storage, "owner-b")
        expect(lease.inFlight?.deliveries[0]?.definitionHash).toBe("definition-v2")

        const [read] = await readAll(storage, lease, "flush-1")
        expect(read?.delivery.definitionHash).toBe("definition-v2")
      }))

    test("stores strings holding U+0000 and backslashes exactly, in values and JSON keys", () =>
      withStorage(async (storage) => {
        // Reproduce: drop the escaping in `encodeDatasetIngestChanges`; PostgreSQL's jsonb refuses
        // the delivery, which `ingest` accepted before it had an inbox.
        const changes: DatasetIngestChange[] = [
          {
            kind: "upsert",
            row: {
              id: "nul\u0000id",
              name: "a\u0000b \\0 \\\\ end\\",
              payload: { "key\u0000": ["\u0000", "\\0"], plain: "\\u0000" },
            },
          },
          { kind: "delete", key: { id: "\u0000" }, sequence: "\\0" },
        ]
        const delivery = await append(storage, changes)

        const lease = await acquire(storage, "owner-a")
        await storage.takeBatch({ lease, flushId: "flush-1", maxChanges: 10 })

        const read = await readAll(storage, lease, "flush-1")
        expect(read.map(({ delivery }) => delivery.id)).toEqual([delivery.id])
        expect(read[0]?.changes).toEqual(changes)
      }))

    test("reads a batch past one page of deliveries", () =>
      withStorage(async (storage) => {
        // Pages hold 50 deliveries: 51 cross the boundary once.
        const appended = []
        for (let index = 0; index < 51; index += 1) {
          appended.push(await append(storage, [upsert(String(index))]))
        }

        const lease = await acquire(storage, "owner-a")
        await storage.takeBatch({ lease, flushId: "flush-1", maxChanges: 1_000 })

        const read = await readAll(storage, lease, "flush-1")
        expect(read.map(({ delivery }) => delivery.id)).toEqual(appended.map(({ id }) => id))
      }))

    test("a hand-over releases the dataset under a request no job used, even with one open", () =>
      withStorage(async (storage) => {
        const { request } = (await storage.append(deliveryInput([upsert("1")]))).flush

        const lease = await acquire(storage, "owner-a")
        const handed = await storage.handOver({ lease })

        expect(handed.request).toBeGreaterThan(request)
        expect(await storage.summarize({ projectId })).toMatchObject([
          { datasetId, pendingDeliveries: 1, request: handed.request, leaseExpiresAt: null },
        ])

        // The request it opened covers the next delivery: nothing asks twice.
        const covered = (await storage.append(deliveryInput([upsert("2")]))).flush
        expect(covered).toEqual({ request: handed.request, requested: false })

        await acquire(storage, "owner-b")
      }))

    test("a hand-over refuses a lease another flush took", () =>
      withStorage(async (storage) => {
        await storage.append(deliveryInput([upsert("1")]))

        const lost = await acquire(storage, "owner-a", 0)
        await acquire(storage, "owner-b")

        const failure = await storage.handOver({ lease: lost }).catch((error) => error)
        expect(failure).toBeInstanceOf(DatasetIngestLeaseLostError)
      }))

    test("asks for a flush with the first delivery of a request, and a batch opens the next", () =>
      withStorage(async (storage) => {
        const opened = (await storage.append(deliveryInput([upsert("1")]))).flush
        const covered = (await storage.append(deliveryInput([upsert("2")]))).flush

        expect(opened.requested).toBe(true)
        expect(covered).toEqual({ request: opened.request, requested: false })

        // Both deliveries are in the batch, whichever asked.
        const lease = await acquire(storage, "owner-a")
        const batch = await storage.takeBatch({ lease, flushId: "flush-1", maxChanges: 100 })
        expect(batch?.deliveries).toHaveLength(2)

        // One appended after the batch asks again, under a request no job used yet.
        const next = (await storage.append(deliveryInput([upsert("3")]))).flush
        expect(next.requested).toBe(true)
        expect(next.request).toBeGreaterThan(opened.request)
      }))

    test("takes whole deliveries in inbox order up to the bound, and always one", () =>
      withStorage(async (storage) => {
        const three = await append(storage, [upsert("1"), upsert("2"), upsert("3")])
        const two = await append(storage, [upsert("4"), upsert("5")])
        const one = await append(storage, [upsert("6")])

        const lease = await acquire(storage, "owner-a")

        // The first delivery alone holds more than the bound: it is taken alone.
        const first = await storage.takeBatch({ lease, flushId: "flush-1", maxChanges: 2 })
        expect(first?.deliveries.map((delivery) => delivery.id)).toEqual([three.id])
        await storage.complete({ lease, flushId: "flush-1" })

        const second = await storage.takeBatch({ lease, flushId: "flush-2", maxChanges: 3 })
        expect(second?.deliveries.map((delivery) => delivery.id)).toEqual([two.id, one.id])
      }))

    test("refuses a second batch while one is in flight", () =>
      withStorage(async (storage) => {
        await append(storage, [upsert("1")])
        await append(storage, [upsert("2")])
        const lease = await acquire(storage, "owner-a")
        await storage.takeBatch({ lease, flushId: "flush-1", maxChanges: 1 })

        const refused = await storage
          .takeBatch({ lease, flushId: "flush-2", maxChanges: 1 })
          .catch((error) => error)
        expect(refused).toBeInstanceOf(Error)
        expect(String(refused)).toContain("still in flight")
      }))

    test("releases the lease when nothing is pending", () =>
      withStorage(async (storage) => {
        const lease = await acquire(storage, "owner-a")

        expect(await storage.takeBatch({ lease, flushId: "flush-1", maxChanges: 10 })).toBeNull()
        expect((await storage.acquire(acquireInput("owner-b"))).acquired).toBe(true)
      }))

    test("gives the dataset to one owner while its lease is live", () =>
      withStorage(async (storage) => {
        const lease = await acquire(storage, "owner-a")
        const busy = await storage.acquire(acquireInput("owner-b"))

        expect(busy).toEqual({ acquired: false, busyUntil: lease.expiresAt })

        // The holder may take it again, which renews it.
        expect((await storage.acquire(acquireInput("owner-a"))).acquired).toBe(true)

        const renewed = await storage.renew({ lease, leaseMs: LEASE_MS })
        expect(renewed?.owner).toBe("owner-a")

        await storage.release({ lease })
        expect((await storage.acquire(acquireInput("owner-b"))).acquired).toBe(true)
      }))

    test("hands an expired lease's batch to the next owner, and fences the old one", () =>
      withStorage(async (storage) => {
        const delivery = await append(storage, [upsert("1")])
        const expired = await acquire(storage, "owner-a", 0)
        const batch = await storage.takeBatch({
          lease: expired,
          flushId: "flush-1",
          maxChanges: 10,
        })

        const taken = await storage.acquire(acquireInput("owner-b"))
        if (!taken.acquired) throw new Error("expected the expired lease to be taken over")

        expect(taken.lease.inFlight).toEqual({
          flushId: "flush-1",
          startedAt: batch?.startedAt ?? new Date(0),
          deliveries: [delivery],
        })

        expect(await storage.renew({ lease: expired, leaseMs: LEASE_MS })).toBeNull()

        const lost = await storage
          .complete({ lease: expired, flushId: "flush-1" })
          .catch((error) => error)
        expect(lost).toBeInstanceOf(DatasetIngestLeaseLostError)

        // A failure the old owner reports is not counted: the lease is the new owner's.
        expect(await storage.fail({ lease: expired })).toEqual({ failureStreak: 0 })

        await storage.complete({ lease: taken.lease, flushId: "flush-1" })
        expect(await storage.summarize({ projectId })).toMatchObject([
          { datasetId, pendingDeliveries: 0 },
        ])
      }))

    test("rejects chosen deliveries, completes the rest, and counts failures in a row", () =>
      withStorage(async (storage) => {
        const kept = await append(storage, [upsert("1")])
        const refused = await append(storage, [upsert("2"), upsert("3")])
        const lease = await acquire(storage, "owner-a")
        await storage.takeBatch({ lease, flushId: "flush-1", maxChanges: 10 })

        await storage.reject({ lease, flushId: "flush-1", deliveryIds: [refused.id] })
        const read = await readAll(storage, lease, "flush-1")
        expect(read.map(({ delivery }) => delivery.id)).toEqual([kept.id])

        expect(await storage.fail({ lease })).toEqual({ failureStreak: 1 })

        const again = await acquire(storage, "owner-b")
        expect(again.inFlight?.deliveries).toEqual([kept])
        expect(await storage.fail({ lease: again })).toEqual({ failureStreak: 2 })

        const last = await acquire(storage, "owner-c")
        await storage.complete({ lease: last, flushId: "flush-1" })

        expect(await storage.summarize({ projectId })).toEqual([
          {
            datasetId,
            pendingDeliveries: 0,
            pendingChanges: 0,
            oldestReceivedAt: null,
            request: 1,
            leaseExpiresAt: last.expiresAt,
            failureStreak: 0,
            lastFlushedAt: expect.any(Date),
          },
        ])
      }))

    test("summarizes what waits per dataset and keeps projects apart", () =>
      withStorage(async (storage) => {
        const oldest = await append(storage, [upsert("1"), upsert("2")])
        await append(storage, [upsert("3")])
        await storage.append({ ...deliveryInput([upsert("1")]), datasetId: "crm.orgs" })
        await storage.append({ ...deliveryInput([upsert("1")]), projectId: "another-project" })

        expect(await storage.summarize({ projectId, datasetIds: [datasetId] })).toEqual([
          {
            datasetId,
            pendingDeliveries: 2,
            pendingChanges: 3,
            oldestReceivedAt: oldest.receivedAt,
            request: 0,
            leaseExpiresAt: null,
            failureStreak: 0,
            lastFlushedAt: null,
          },
        ])

        const all = await storage.summarize({ projectId })
        expect(all.map((summary) => summary.datasetId)).toEqual(["crm.orgs", datasetId])

        const lease = await acquire(storage, "owner-a")
        const otherProject = await storage.acquire({
          ...acquireInput("owner-b"),
          projectId: "another-project",
        })
        expect(otherProject.acquired).toBe(true)
        expect(
          await storage.takeBatch({ lease, flushId: "flush-1", maxChanges: 10 })
        ).not.toBeNull()
      }))

    test("refuses an empty delivery", () =>
      withStorage(async (storage) => {
        const refused = await storage.append(deliveryInput([])).catch((error) => error)
        expect(String(refused)).toContain("at least one change")
      }))
  })
}

function upsert(id: string): DatasetIngestChange {
  return { kind: "upsert", row: { id, name: `Person ${id}` } }
}

function deliveryInput(changes: readonly DatasetIngestChange[]) {
  return {
    projectId,
    datasetId,
    executionId: "exec-1",
    correlationId: "corr-1",
    definitionHash: "definition-1",
    changes,
  }
}

async function append(storage: DatasetIngestStorage, changes: readonly DatasetIngestChange[]) {
  return (await storage.append(deliveryInput(changes))).delivery
}

function acquireInput(owner: string, leaseMs = LEASE_MS) {
  return { projectId, datasetId, owner, leaseMs }
}

async function acquire(
  storage: DatasetIngestStorage,
  owner: string,
  leaseMs = LEASE_MS
): Promise<DatasetIngestLease> {
  const result = await storage.acquire(acquireInput(owner, leaseMs))
  if (!result.acquired) throw new Error(`expected ${owner} to acquire the dataset`)
  return result.lease
}

async function readAll(storage: DatasetIngestStorage, lease: DatasetIngestLease, flushId: string) {
  const read = []
  for await (const delivery of storage.readChanges({ lease, flushId })) read.push(delivery)
  return read
}
