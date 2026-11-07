import { afterEach, describe, expect, jest, test } from "bun:test"
import {
  col,
  defineConnector,
  defineDataset,
  defineObjectType,
  defineSync,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LakeMaintenanceOptions,
  prop,
  type SixbErrorContext,
  SixbHost,
  type SyncDefinition,
} from "@sixb/core"
import type { LakeMaintenance, LakeRetentionReport } from "@sixb/core/lake-storage"
import { SyncWorker } from "../src"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const rooms = defineDataset("raw.rooms", { schema: [col("id", "string")] })

const erpDb = defineConnector("erpDb", {
  type: "sql",
  connect() {
    return {}
  },
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
  readonly passes: { resolve(): void; reject(error: Error): void }[] = []

  readonly maintenance: LakeMaintenance = {
    applyRetention: () =>
      new Promise<LakeRetentionReport>((resolve, reject) => {
        this.passes.push({ resolve: () => resolve(REPORT), reject })
      }),
    describeStorage: async () => [],
  }
}

const workers: SyncWorker[] = []
const lakes: ControlledLakeStorage[] = []

afterEach(async () => {
  // A pass a failing test left open would otherwise keep its worker from stopping.
  for (const lake of lakes.splice(0)) for (const pass of lake.passes) pass.resolve()
  await Promise.all(workers.splice(0).map((worker) => worker.stop()))
  jest.useRealTimers()
})

function createHost(
  input: {
    syncs?: SyncDefinition[]
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
    datasets: [rooms],
    connectors: [erpDb],
    syncs: input.syncs ?? [],
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

async function start(sixb: SixbHost, options?: ConstructorParameters<typeof SyncWorker>[1]) {
  const worker = new SyncWorker(sixb, options)
  workers.push(worker)
  await worker.start()
  return worker
}

async function enqueueRetention(queues: InMemoryQueues, occurrenceAt: string) {
  await queues.lake.enqueue({
    projectId: PROJECT_ID,
    jobs: [
      {
        id: `sixb:lake-retention:${occurrenceAt}`,
        type: "lake.retention.requested",
        payload: { occurrenceAt },
      },
    ],
  })
}

async function enqueueSyncRun(sixb: SixbHost, sync: SyncDefinition, runId: string) {
  const executionId = `exec:${runId}`
  await sixb.storage.executions.create({
    id: executionId,
    projectId: sixb.id,
    executor: { type: "primitive", kind: "sync", runId },
    source: { type: "schedule", eventId: `event:${runId}` },
    correlationId: `correlation:${runId}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "sync", id: sync.id, runId },
    },
  })
  await sixb.storage.syncRuns!.queue({
    id: runId,
    projectId: sixb.id,
    executionId,
    syncId: sync.id,
    datasetId: sync.target.dataset.id,
    mode: sync.config.mode,
  })
  await sixb.queues.syncRuns.enqueue({
    projectId: sixb.id,
    jobs: [{ id: runId, type: "sync.run.requested", payload: { runId } }],
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

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const warn = console.warn
  console.warn = () => {}
  try {
    return await run()
  } finally {
    console.warn = warn
  }
}

describe("SyncWorker lake lane", () => {
  // Reproduce: keep the "No sync definitions" refusal in SyncWorker's constructor.
  test("starts without syncs when lake retention is scheduled, and runs an occurrence", async () => {
    const { sixb, lakeStorage, queues } = createHost()
    await start(sixb)

    await enqueueRetention(queues, new Date().toISOString())

    await eventually(() => lakeStorage.passes.length === 1)
    lakeStorage.passes[0]!.resolve()
  })

  test("refuses to start with neither syncs nor scheduled lake retention", () => {
    const { sixb } = createHost({ lakeMaintenance: { enabled: false } })

    expect(() => new SyncWorker(sixb)).toThrow(
      "[SixbSyncWorker] No sync definitions are registered, and lake retention is not scheduled."
    )
  })

  // Reproduce: drop the LakeWorker's start from SyncWorker.start(); lake jobs then wait forever.
  test("runs lake retention while a sync holds the only sync slot", async () => {
    let releaseSync = () => {}
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve
    })
    let syncStarted = false
    const blocking = defineSync("blocking")
      .from(erpDb)
      .read(async () => {
        syncStarted = true
        await syncGate
        return []
      })
      .intoDataset(rooms)
    const { sixb, lakeStorage, queues } = createHost({ syncs: [blocking] })
    await start(sixb, { concurrency: 1 })

    await enqueueSyncRun(sixb, blocking, "run-blocking")
    await eventually(() => syncStarted)
    await enqueueRetention(queues, new Date().toISOString())

    await eventually(() => lakeStorage.passes.length === 1)
    lakeStorage.passes[0]!.resolve()
    releaseSync()
  })

  // Reproduce: set LAKE_CONCURRENCY to 1 in lake-worker.ts.
  test("runs two lake jobs at once", async () => {
    const { sixb, lakeStorage, queues } = createHost()
    await start(sixb)
    const now = Date.now()

    await enqueueRetention(queues, new Date(now - MINUTE).toISOString())
    await enqueueRetention(queues, new Date(now).toISOString())

    await eventually(() => lakeStorage.passes.length === 2)
    for (const pass of lakeStorage.passes) pass.resolve()
  })

  // Reproduce: return `{ kind: "fail" }` on the first error in lake-worker.ts.
  test("retries a failed run a minute later, and reports the third failure once", async () => {
    jest.useFakeTimers()
    const errors: SixbErrorContext[] = []
    const { sixb, lakeStorage, queues } = createHost({ errors })
    let retries = 0
    const retry = queues.lake.retry.bind(queues.lake)
    queues.lake.retry = async (input) => {
      await retry(input)
      retries += 1
    }
    await start(sixb)
    const occurrenceAt = new Date().toISOString()

    await quietly(async () => {
      await enqueueRetention(queues, occurrenceAt)
      await eventually(() => lakeStorage.passes.length === 1)

      for (const attempt of [1, 2]) {
        lakeStorage.passes[attempt - 1]!.reject(new Error("catalog unreachable"))
        await eventually(() => retries === attempt)

        jest.advanceTimersByTime(MINUTE - 1)
        await eventually(() => false, 50).catch(() => {})
        expect(lakeStorage.passes).toHaveLength(attempt)

        jest.advanceTimersByTime(1)
        await eventually(() => lakeStorage.passes.length === attempt + 1)
      }

      expect(errors).toEqual([])
      lakeStorage.passes[2]!.reject(new Error("catalog unreachable"))
      await eventually(() => errors.length === 1)
    })

    expect(retries).toBe(2)
    expect(errors).toEqual([
      expect.objectContaining({
        type: "lake.retention.failed",
        projectId: PROJECT_ID,
        occurrenceAt,
        attempt: 3,
        notificationId: `lake-retention:${PROJECT_ID}:${occurrenceAt}`,
        failure: expect.objectContaining({ code: "internal.unexpected" }),
      }),
    ])
  })
})
