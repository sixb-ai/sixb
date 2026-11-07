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

async function enqueueRetention(queues: InMemoryQueues, requestedAt: string) {
  await queues.lake.enqueue({
    projectId: PROJECT_ID,
    jobs: [
      {
        id: `lake-retention:${requestedAt}`,
        type: "lake.retention.requested",
        payload: { requestedAt },
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

  // Reproduce: return `{ kind: "retry" }` from onExecutionError in lake-worker.ts; the job then runs
  // again and the failure goes unreported.
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
    const requestedAt = new Date().toISOString()

    await enqueueRetention(queues, requestedAt)
    await eventually(() => lakeStorage.passes.length === 1)
    lakeStorage.passes[0]!.reject(new Error("catalog unreachable"))
    await eventually(() => failed.length === 1)

    expect(failed).toEqual([`lake-retention:${requestedAt}`])
    expect(errors).toEqual([
      expect.objectContaining({
        type: "lake.retention.failed",
        projectId: PROJECT_ID,
        requestedAt,
        notificationId: `lake-retention:${PROJECT_ID}:${requestedAt}`,
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

  test("skips a backlog's old requests without running them", async () => {
    const { sixb, lakeStorage, queues } = createHost()
    const completed: string[] = []
    const complete = queues.lake.complete.bind(queues.lake)
    queues.lake.complete = async (input) => {
      await complete(input)
      completed.push(input.jobId)
    }
    await start(sixb)
    const old = new Date(Date.now() - 2 * 60 * MINUTE).toISOString()
    const current = new Date().toISOString()

    await enqueueRetention(queues, old)
    await enqueueRetention(queues, current)

    await eventually(() => lakeStorage.passes.length === 1)
    lakeStorage.passes[0]!.resolve()
    await eventually(() => completed.length === 2)

    expect(lakeStorage.passes).toHaveLength(1)
  })

  // Reproduce: fail the job in onAbortError in lake-worker.ts.
  test("returns the job to the queue on shutdown, without reporting a failure", async () => {
    const errors: SixbErrorContext[] = []
    const { sixb, lakeStorage, queues } = createHost({ errors })
    const worker = await start(sixb)
    const requestedAt = new Date().toISOString()

    await enqueueRetention(queues, requestedAt)
    await eventually(() => lakeStorage.passes.length === 1)

    const stopping = worker.stop()
    lakeStorage.passes[0]!.resolve()
    await stopping

    expect(errors).toEqual([])
  })
})
