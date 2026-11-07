import { afterEach, describe, expect, jest, test } from "bun:test"
import {
  change,
  col,
  defineDataset,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LakeMaintenanceOptions,
  prop,
  type SixbErrorContext,
  SixbHost,
} from "@sixb/core"
import type { LakeMaintenance, LakeRetentionReport } from "@sixb/core/lake-storage"
import { createTestingScope } from "../../core/src/execution/scopes"
import { LakeWorker, type LakeWorkerOptions } from "../src"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const rooms = defineDataset("raw.rooms", { schema: [col("id", "string")] })

const people = defineDataset("raw.people", {
  schema: [col("id", "string"), col("name", "string")],
  primaryKey: "id",
})

const PROJECT_ID = "lake-project"
const MINUTE = 60_000

const REPORT: LakeRetentionReport = {
  dryRun: false,
  keepVersionsForMs: 0,
  deleteFilesAfterMs: 0,
  expiredVersions: 0,
  keptVersions: 0,
  deletedFiles: 0,
  orphanedFiles: 0,
  hasMore: false,
}

/** A provider whose passes wait for the test to settle them, one at a time. */
class ControlledLakeStorage extends InMemoryLakeStorage {
  readonly passes: {
    resolve(report?: Partial<LakeRetentionReport>): void
    reject(error: Error): void
  }[] = []

  readonly maintenance: LakeMaintenance = {
    applyRetention: () =>
      new Promise<LakeRetentionReport>((resolve, reject) => {
        this.passes.push({ resolve: (report) => resolve({ ...REPORT, ...report }), reject })
      }),
    describeStorage: async () => [],
  }
}

const workers: LakeWorker[] = []
const lakes: ControlledLakeStorage[] = []

afterEach(async () => {
  // A pass a failing test left open would otherwise keep its worker from stopping.
  for (const lake of lakes.splice(0)) for (const pass of lake.passes) pass.resolve()
  await Promise.all(workers.splice(0).map((worker) => worker.stop()))
  jest.useRealTimers()
})

function createHost(
  input: {
    ingest?: boolean
    lakeMaintenance?: LakeMaintenanceOptions
    errors?: SixbErrorContext[]
  } = {}
) {
  const lakeStorage = new ControlledLakeStorage()
  lakes.push(lakeStorage)
  const queues = new InMemoryQueues()
  const sixb = new SixbHost({
    id: PROJECT_ID,
    ontology: [Room],
    datasets: input.ingest ? [rooms, people] : [rooms],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage,
    lakeMaintenance: input.lakeMaintenance,
    blobStorage: new InMemoryBlobStorage(),
    queues,
    onError: (_error, context) => {
      input.errors?.push(context)
    },
  })

  return { sixb, lakeStorage, queues }
}

async function start(sixb: SixbHost, options?: LakeWorkerOptions) {
  const worker = new LakeWorker(sixb, options)
  workers.push(worker)
  await worker.start()
  return worker
}

/** Stores a delivery as `ingest` does, leaving its flush to the worker under test. */
async function ingestPerson(sixb: SixbHost, id: string) {
  await sixb.storage.datasetIngest?.append({
    projectId: PROJECT_ID,
    datasetId: people.id,
    executionId: `exec-${id}`,
    correlationId: `corr-${id}`,
    changes: [change.upsert(person(id))],
  })
}

function person(id: string) {
  return { id, name: `Person ${id}` }
}

/** Queues a flush for what waits, as the orchestrator's `ingest` pass does. */
async function askLikeTheIngestPass(sixb: SixbHost, queues: InMemoryQueues) {
  const summaries = await sixb.storage.datasetIngest!.summarize({ projectId: PROJECT_ID })

  for (const { request, pendingDeliveries, leaseExpiresAt } of summaries) {
    if (pendingDeliveries > 0 && leaseExpiresAt === null) await enqueueFlush(queues, request)
  }
}

async function enqueueFlush(queues: InMemoryQueues, request: number) {
  await queues.lake.enqueue({
    projectId: PROJECT_ID,
    jobs: [
      {
        id: `ingest-flush:${people.id}:${request}`,
        type: "dataset.ingest.flush.requested",
        payload: { datasetId: people.id },
      },
    ],
  })
}

async function enqueueRetention(queues: InMemoryQueues, intervalStart: string) {
  await queues.lake.enqueue({
    projectId: PROJECT_ID,
    jobs: [
      {
        id: `lake-retention:${intervalStart}`,
        type: "lake.retention.requested",
        payload: { intervalStart },
      },
    ],
  })
}

/** Waits a bounded number of event-loop turns: fake timers freeze the clock a timeout would use. */
async function eventually(predicate: () => boolean, turns = 500): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Condition not reached.")
}

/** As `eventually`, for a condition read from storage. */
async function eventuallyAsync(predicate: () => Promise<boolean>, turns = 500): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Condition not reached.")
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const warn = console.warn
  console.warn = () => {}
  try {
    return await run()
  } finally {
    console.warn = warn
  }
}

describe("LakeWorker", () => {
  // Reproduce: drop DEFAULT_CONCURRENCY from `claimLimit` in worker.ts.
  test("runs four jobs at once unless told otherwise", () => {
    const { sixb } = createHost()

    expect(new LakeWorker(sixb).concurrency).toBe(4)
    expect(new LakeWorker(sixb, { concurrency: 3 }).concurrency).toBe(3)
  })

  // Reproduce: set DEFAULT_CONCURRENCY to 1 in worker.ts, and the flush waits behind the run; or
  // drop the `retentionRunning` check, and each request takes a slot and runs beside the first.
  test("flushes ingested changes beside a retention run, and runs one retention at a time", async () => {
    const { sixb, lakeStorage, queues } = createHost({ ingest: true })
    await start(sixb)
    const now = Date.now()

    // More requests than slots: one runs, the others find it running and leave it the work.
    for (let minutes = 4; minutes >= 0; minutes -= 1) {
      await enqueueRetention(queues, new Date(now - minutes * MINUTE).toISOString())
    }
    await eventually(() => lakeStorage.passes.length === 1)

    await ingestPerson(sixb, "1")
    await enqueueFlush(queues, 0)
    await eventuallyAsync(async () => (await lakeStorage.listVersions(people.id)).length === 1)

    lakeStorage.passes[0]!.resolve()
    await eventually(() => false, 50).catch(() => {})
    expect(lakeStorage.passes).toHaveLength(1)
  })

  // Reproduce: read the retention runtime alone, and refuse a host that does not run it.
  test("flushes a dataset that can be ingested, without retention", async () => {
    const { sixb, lakeStorage, queues } = createHost({
      ingest: true,
      lakeMaintenance: { enabled: false },
    })
    await start(sixb)

    await ingestPerson(sixb, "1")
    await enqueueFlush(queues, 0)

    await eventuallyAsync(async () => (await lakeStorage.listVersions(people.id)).length === 1)
  })

  // Reproduce: return `{ kind: "fail" }` from `retryFlush` in worker.ts.
  test("retries a failing flush sooner at first, and never fails its job", async () => {
    jest.useFakeTimers()
    const errors: SixbErrorContext[] = []
    const { sixb, lakeStorage, queues } = createHost({ ingest: true, errors })
    const retried: string[] = []
    const retry = queues.lake.retry.bind(queues.lake)
    queues.lake.retry = async (input) => {
      retried.push(input.availableAt ?? "now")
      await retry(input)
    }
    const fail = queues.lake.fail.bind(queues.lake)
    let failed = 0
    queues.lake.fail = async (input) => {
      failed += 1
      await fail(input)
    }

    const beginMerge = lakeStorage.beginMerge.bind(lakeStorage)
    let offline = true
    lakeStorage.beginMerge = async (input) => {
      if (offline) throw new Error("lake offline")
      return beginMerge(input)
    }

    await start(sixb)
    await ingestPerson(sixb, "1")

    await quietly(async () => {
      await enqueueFlush(queues, 0)
      await eventually(() => retried.length === 1)
      expect(Date.parse(retried[0]!) - Date.now()).toBe(1_000)

      jest.advanceTimersByTime(1_000)
      await eventually(() => retried.length === 2)
      expect(Date.parse(retried[1]!) - Date.now()).toBe(2_000)

      offline = false
      jest.advanceTimersByTime(2_000)
      await eventuallyAsync(async () => (await lakeStorage.listVersions(people.id)).length === 1)
    })

    expect(failed).toBe(0)
    expect(errors).toEqual([])
  })

  // The job that resumes a dead flush's batch runs under the open request, which only a new batch
  // moves. Past its budget, asking again under that request names the job itself, and a queue
  // ignores an id it remembers: the delivery joins the request, the `ingest` pass asks under the
  // same id, and nothing flushes the dataset until the queue forgets the job.
  // Reproduce: leave `request` as it is in `handOver` (provider.ts).
  test("a job that resumes a batch and spends its budget leaves a job for what came after", async () => {
    jest.useFakeTimers()
    const { sixb, lakeStorage, queues } = createHost({ ingest: true })
    const inbox = sixb.storage.datasetIngest!

    await ingestPerson(sixb, "1")

    const dead = await inbox.acquire({
      projectId: PROJECT_ID,
      datasetId: people.id,
      owner: "dead-flush",
      leaseMs: 0,
    })
    if (!dead.acquired) throw new Error("expected the test to hold the lease")
    await inbox.takeBatch({ lease: dead.lease, flushId: "flush_dead", maxChanges: 10 })

    // The resumed batch takes the whole budget, and a delivery arrives while it does.
    const handler = sixb.withScope(createTestingScope({ projectId: PROJECT_ID }))
    const beginMerge = lakeStorage.beginMerge.bind(lakeStorage)
    lakeStorage.beginMerge = async (input) => {
      lakeStorage.beginMerge = beginMerge
      jest.setSystemTime(new Date(Date.now() + 31_000))
      await handler.datasets.ingest(people, { changes: [change.upsert(person("2"))] })
      return beginMerge(input)
    }

    await start(sixb)
    await askLikeTheIngestPass(sixb, queues)

    await eventuallyAsync(async () => (await lakeStorage.listVersions(people.id)).length >= 1)
    await askLikeTheIngestPass(sixb, queues)

    await eventuallyAsync(async () => (await lakeStorage.listVersions(people.id)).length === 2)
    expect(await inbox.summarize({ projectId: PROJECT_ID })).toEqual([])
  })

  // Reproduce: complete the job when the flush answers "busy", and the delivery waits for a
  // request no job serves; or retry it when the other lease expires, and it waits up to a minute
  // after that flush has finished.
  test("tries again within a second when another flush holds the dataset", async () => {
    jest.useFakeTimers()
    const errors: SixbErrorContext[] = []
    const { sixb, lakeStorage, queues } = createHost({ ingest: true, errors })
    const retried: string[] = []
    const retry = queues.lake.retry.bind(queues.lake)
    queues.lake.retry = async (input) => {
      retried.push(input.availableAt ?? "now")
      await retry(input)
    }

    await ingestPerson(sixb, "1")
    const inbox = sixb.storage.datasetIngest!
    const held = await inbox.acquire({
      projectId: PROJECT_ID,
      datasetId: people.id,
      owner: "another-worker",
      leaseMs: 60_000,
    })
    if (!held.acquired) throw new Error("expected the test to hold the lease")

    await start(sixb)
    await enqueueFlush(queues, 0)

    await eventually(() => retried.length === 1)
    expect(Date.parse(retried[0]!) - Date.now()).toBe(1_000)
    expect(await lakeStorage.listVersions(people.id)).toEqual([])

    // The other flush finishes long before its lease would expire.
    await inbox.release({ lease: held.lease })
    jest.advanceTimersByTime(1_000)

    await eventuallyAsync(async () => (await lakeStorage.listVersions(people.id)).length === 1)
    expect(errors).toEqual([])
  })

  test("runs a retention request", async () => {
    const { sixb, lakeStorage, queues } = createHost()
    await start(sixb)

    await enqueueRetention(queues, new Date().toISOString())

    await eventually(() => lakeStorage.passes.length === 1)
    lakeStorage.passes[0]!.resolve()
  })

  // Listing `lake` is what the docs ask of a deployment, and `enabled: false` what they offer as
  // the way out: the two together must not take the worker group down.
  test("idles when lake retention does not run on its own", async () => {
    const { sixb, queues } = createHost({ lakeMaintenance: { enabled: false } })
    const worker = await start(sixb)

    await enqueueRetention(queues, new Date().toISOString())
    await eventually(() => false, 20).catch(() => {})

    await worker.stop()
    expect(await sixb.storage.lakeRetentionRuns?.getLast({ projectId: PROJECT_ID })).toBeNull()
  })

  // Reproduce: return `{ kind: "retry" }` from onExecutionError in worker.ts.
  test("reports a failed run once and leaves the next interval to try again", async () => {
    const errors: SixbErrorContext[] = []
    const { sixb, lakeStorage, queues } = createHost({ errors })
    const failed: string[] = []
    const fail = queues.lake.fail.bind(queues.lake)
    queues.lake.fail = async (input) => {
      await fail(input)
      failed.push(input.jobId)
    }
    await start(sixb)
    const intervalStart = new Date().toISOString()

    await enqueueRetention(queues, intervalStart)
    await eventually(() => lakeStorage.passes.length === 1)
    lakeStorage.passes[0]!.reject(new Error("catalog unreachable"))
    await eventually(() => failed.length === 1)

    expect(failed).toEqual([`lake-retention:${intervalStart}`])
    expect(errors).toEqual([
      expect.objectContaining({
        type: "lake.retention.failed",
        projectId: PROJECT_ID,
        intervalStart,
        notificationId: `lake-retention:${PROJECT_ID}:${intervalStart}`,
        failure: expect.objectContaining({ code: "internal.unexpected" }),
      }),
    ])
  })

  // On a short interval the run after a failure can land past the interval, which used to complete
  // the job without a report. Reproduce: retry in onExecutionError and skip past the interval.
  test("reports the failure of a run that outlasted its interval", async () => {
    jest.useFakeTimers()
    const errors: SixbErrorContext[] = []
    const { sixb, lakeStorage, queues } = createHost({
      errors,
      lakeMaintenance: { cleanupEvery: "2m" },
    })
    await start(sixb)

    await enqueueRetention(queues, new Date().toISOString())
    await eventually(() => lakeStorage.passes.length === 1)

    jest.advanceTimersByTime(3 * MINUTE)
    lakeStorage.passes[0]!.reject(new Error("catalog unreachable"))
    await eventually(() => errors.length === 1)

    expect(errors[0]?.type).toBe("lake.retention.failed")
  })

  // Reproduce: return `{ kind: "fail" }` from an `onAbortError` override in worker.ts.
  test("returns the job to the queue on shutdown, and reports nothing", async () => {
    const errors: SixbErrorContext[] = []
    const { sixb, lakeStorage, queues } = createHost({ errors })
    const worker = await start(sixb)
    const intervalStart = new Date().toISOString()

    await enqueueRetention(queues, intervalStart)
    await eventually(() => lakeStorage.passes.length === 1)

    const stopping = worker.stop()
    lakeStorage.passes[0]!.resolve({ hasMore: true })
    await stopping

    const [redelivered] = await queues.lake.claim({ projectId: PROJECT_ID, workerId: "next" })

    expect(redelivered?.job).toMatchObject({ id: `lake-retention:${intervalStart}`, attempt: 2 })
    expect(errors).toEqual([])
  })
})
