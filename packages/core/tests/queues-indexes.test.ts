import { afterEach, expect, spyOn, test } from "bun:test"
import { InMemoryQueues } from "../src/queues/in-memory"

const nowSpy = () => spyOn(Date, "now")
let clock: ReturnType<typeof nowSpy> | undefined
afterEach(() => clock?.mockRestore())
const iso = (time: number) => new Date(time).toISOString()
const origin = Date.parse("2026-09-19T00:00:00.000Z")

// Restore queues/in-memory.ts before this fix to reproduce the red check. Instrument record
// reads (both old array and current map layouts), not wall time or a particular heap shape.
function watchRecordReads(value: unknown): () => number {
  const seen = new Set<object>()
  let reads = 0
  function walk(item: unknown): void {
    if (item === null || typeof item !== "object" || seen.has(item)) return
    seen.add(item)
    if ("sequence" in item && "queueId" in item && "state" in item && "job" in item) {
      for (const key of ["queueId", "state", "job"]) {
        let current: unknown = Reflect.get(item, key)
        Object.defineProperty(item, key, {
          configurable: true,
          enumerable: true,
          get() {
            reads += 1
            return current
          },
          set(next: unknown) {
            current = next
          },
        })
      }
      return
    }
    if (item instanceof Map) for (const entry of item.values()) walk(entry)
    else if (Array.isArray(item)) for (const entry of item) walk(entry)
    else for (const entry of Object.values(item)) walk(entry)
  }
  walk(value)
  return () => reads
}

test("claim and settlement do not revisit the retained job population", async () => {
  const queues = new InMemoryQueues()
  const queue = queues.projections
  await queue.enqueue({
    projectId: "test",
    jobs: Array.from({ length: 5000 }, (_, i) => ({
      id: String(i),
      type: "projection.run.requested" as const,
      payload: { runId: String(i) },
    })),
  })
  const reads = watchRecordReads(Reflect.get(queues, "store"))
  for (let i = 0; i < 100; i++) {
    const [claimed] = await queue.claim({ projectId: "test", workerId: "worker" })
    expect(claimed?.job.id).toBe(String(i))
    await queue.complete({ projectId: "test", jobId: claimed!.job.id, leaseId: claimed!.leaseId })
  }
  expect(reads()).toBeLessThan(10000)
  // Terminal history remains authoritative for deduplication, including its attempt count.
  const [same] = await queue.enqueue({
    projectId: "test",
    jobs: [{ id: "0", type: "projection.run.requested", payload: { runId: "different" } }],
  })
  expect(same).toMatchObject({ id: "0", attempt: 1, payload: { runId: "0" } })
}, 15000)

test("expired leases rejoin available jobs in original availability order", async () => {
  let now = origin
  clock = nowSpy().mockImplementation(() => now)
  const queue = new InMemoryQueues().projections
  await queue.enqueue({
    projectId: "test",
    jobs: [
      {
        id: "old",
        type: "projection.run.requested",
        availableAt: iso(origin - 100),
        payload: { runId: "old" },
      },
      {
        id: "new",
        type: "projection.run.requested",
        availableAt: iso(origin + 5),
        payload: { runId: "new" },
      },
    ],
  })
  const [first] = await queue.claim({ projectId: "test", workerId: "a", leaseMs: 20 })
  now += 30
  const rows = await queue.claim({ projectId: "test", workerId: "b", limit: 2 })
  expect(rows.map((row) => [row.job.id, row.job.attempt])).toEqual([
    ["old", 2],
    ["new", 1],
  ])
  await expect(
    queue.complete({ projectId: "test", jobId: "old", leaseId: first!.leaseId })
  ).rejects.toThrow("Lease mismatch")
})

test("renewal replaces the wake-up time and retry reorders a delayed job", async () => {
  let now = origin
  clock = nowSpy().mockImplementation(() => now)
  const queue = new InMemoryQueues().projections
  await queue.enqueue({
    projectId: "test",
    jobs: [
      {
        id: "a",
        type: "projection.run.requested",
        availableAt: iso(origin),
        payload: { runId: "a" },
      },
    ],
  })
  const [first] = await queue.claim({ projectId: "test", workerId: "worker", leaseMs: 20 })
  for (let i = 0; i < 100; i++)
    await queue.renewLease!({
      projectId: "test",
      jobId: "a",
      leaseId: first!.leaseId,
      leaseMs: 100,
    })
  now += 30
  expect(await queue.claim({ projectId: "test", workerId: "other" })).toEqual([])
  await queue.retry({
    projectId: "test",
    jobId: "a",
    leaseId: first!.leaseId,
    availableAt: iso(origin + 200),
  })
  now = origin + 150
  expect(await queue.claim({ projectId: "test", workerId: "other" })).toEqual([])
  now = origin + 200
  const [retry] = await queue.claim({ projectId: "test", workerId: "other" })
  expect(retry?.job).toMatchObject({ id: "a", attempt: 2 })
  await queue.complete({ projectId: "test", jobId: "a", leaseId: retry!.leaseId })
  now += 60000
  expect(await queue.claim({ projectId: "test", workerId: "other" })).toEqual([])
})

test("ready jobs respect a backwards clock adjustment", async () => {
  let now = origin
  clock = nowSpy().mockImplementation(() => now)
  const queue = new InMemoryQueues().projections
  await queue.enqueue({
    projectId: "test",
    jobs: [
      {
        id: "a",
        type: "projection.run.requested",
        availableAt: iso(origin),
        payload: { runId: "a" },
      },
    ],
  })
  now -= 10
  expect(await queue.claim({ projectId: "test", workerId: "worker" })).toEqual([])
  now = origin
  expect(await queue.claim({ projectId: "test", workerId: "worker" })).toHaveLength(1)
})

// The initial index prototype cached fractional milliseconds, unlike the serialized lease.
// Cache `now + leaseMs` instead of Date.getTime() to reproduce this regression.
test("fractional leases expire at the timestamp returned to the worker", async () => {
  clock = nowSpy().mockReturnValue(origin)
  const queue = new InMemoryQueues().projections
  await queue.enqueue({
    projectId: "test",
    jobs: [
      {
        id: "a",
        type: "projection.run.requested",
        availableAt: iso(origin),
        payload: { runId: "a" },
      },
    ],
  })
  const [first] = await queue.claim({ projectId: "test", workerId: "a", leaseMs: 0.5 })
  expect(first?.leaseExpiresAt).toBe(iso(origin))
  const [second] = await queue.claim({ projectId: "test", workerId: "b", leaseMs: 100 })
  expect(second?.job.attempt).toBe(2)
  const renewed = await queue.renewLease!({
    projectId: "test",
    jobId: "a",
    leaseId: second!.leaseId,
    leaseMs: 0.5,
  })
  expect(renewed?.leaseExpiresAt).toBe(iso(origin))
  expect((await queue.claim({ projectId: "test", workerId: "c" }))[0]?.job.attempt).toBe(3)
})

// Move timestamp construction after takeReady() to reproduce: the rejected batch disappears.
test("an unrepresentable lease cannot remove jobs from the delivery index", async () => {
  clock = nowSpy().mockReturnValue(origin)
  const queue = new InMemoryQueues().projections
  await queue.enqueue({
    projectId: "test",
    jobs: ["a", "b"].map((id) => ({
      id,
      type: "projection.run.requested" as const,
      availableAt: iso(origin),
      payload: { runId: id },
    })),
  })
  await expect(
    queue.claim({
      projectId: "test",
      workerId: "a",
      limit: 2,
      leaseMs: Number.MAX_VALUE,
    })
  ).rejects.toThrow()
  expect(
    (await queue.claim({ projectId: "test", workerId: "b", limit: 2 })).map((row) => row.job.id)
  ).toEqual(["a", "b"])
})

test("mixed retries, renewals and settlements agree with a reference scheduler", async () => {
  let now = origin
  clock = nowSpy().mockImplementation(() => now)
  let seed = 20260919
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % limit
  }
  const queue = new InMemoryQueues().projections
  const jobs = await queue.enqueue({
    projectId: "test",
    jobs: Array.from({ length: 200 }, (_, i) => ({
      id: String(i),
      type: "projection.run.requested" as const,
      availableAt: iso(origin + random(100)),
      payload: { runId: String(i) },
    })),
  })
  const records = jobs.map((job, sequence) => ({
    id: job.id,
    sequence,
    available: Date.parse(job.availableAt),
    created: Date.parse(job.createdAt),
    expiry: 0,
    lease: "",
    done: false,
    attempt: 0,
  }))
  for (let step = 0; step < 1500; step++) {
    now += random(4)
    const operation = random(6)
    if (operation <= 2) {
      const limit = random(5) + 1
      const duration = random(100) + 1
      const expected = records
        .filter((record) => !record.done && record.available <= now && record.expiry <= now)
        .sort(
          (a, b) => a.available - b.available || a.created - b.created || a.sequence - b.sequence
        )
        .slice(0, limit)
      const actual = await queue.claim({
        projectId: "test",
        workerId: "worker",
        limit,
        leaseMs: duration,
      })
      expect(actual.map((row) => row.job.id)).toEqual(expected.map((record) => record.id))
      for (const [index, record] of expected.entries()) {
        record.expiry = now + duration
        record.lease = actual[index]!.leaseId
        record.attempt += 1
        expect(actual[index]!.job.attempt).toBe(record.attempt)
      }
    } else {
      const active = records.filter((record) => !record.done && record.expiry > now)
      const record = active[random(active.length || 1)]
      if (!record) continue
      const lease = { projectId: "test", jobId: record.id, leaseId: record.lease }
      if (operation === 3) {
        await queue.complete(lease)
        record.done = true
      } else if (operation === 4) {
        record.available = now + random(100)
        await queue.retry({ ...lease, availableAt: iso(record.available) })
        record.expiry = 0
      } else {
        const duration = random(200) + 1
        expect(await queue.renewLease!({ ...lease, leaseMs: duration })).not.toBeNull()
        record.expiry = now + duration
      }
    }
  }
})
