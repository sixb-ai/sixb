import { afterEach, describe, expect, jest, test } from "bun:test"
import {
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
import { LakeWorker, type LakeWorkerOptions } from "../src"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const rooms = defineDataset("raw.rooms", { schema: [col("id", "string")] })

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
  input: { lakeMaintenance?: LakeMaintenanceOptions; errors?: SixbErrorContext[] } = {}
) {
  const lakeStorage = new ControlledLakeStorage()
  lakes.push(lakeStorage)
  const queues = new InMemoryQueues()
  const sixb = new SixbHost({
    id: PROJECT_ID,
    ontology: [Room],
    datasets: [rooms],
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

/** Waits a bounded number of event-loop turns: fake timers freeze the clock a timeout would use. */
async function eventually(predicate: () => boolean, turns = 500): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Condition not reached.")
}

describe("LakeWorker", () => {
  test("runs a retention request", async () => {
    const { sixb, lakeStorage, queues } = createHost()
    await start(sixb)

    await enqueueRetention(queues, new Date().toISOString())

    await eventually(() => lakeStorage.passes.length === 1)
    lakeStorage.passes[0]!.resolve()
  })

  // Reproduce: drop the refusal from LakeWorker's constructor in worker.ts.
  test("refuses to start when lake retention does not run on its own", () => {
    const { sixb } = createHost({ lakeMaintenance: { enabled: false } })

    expect(() => new LakeWorker(sixb)).toThrow(
      "[SixbLakeWorker] Lake retention does not run on its own in this project."
    )
  })

  // Reproduce: set DEFAULT_CONCURRENCY to 1 in worker.ts.
  test("runs two lake jobs at once by default", async () => {
    const { sixb, lakeStorage, queues } = createHost()
    await start(sixb)
    const now = Date.now()

    await enqueueRetention(queues, new Date(now - MINUTE).toISOString())
    await enqueueRetention(queues, new Date(now).toISOString())

    await eventually(() => lakeStorage.passes.length === 2)
    for (const pass of lakeStorage.passes) pass.resolve()
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

  // Reproduce: return `{ kind: "fail" }` from an `onAbortError` override in worker.ts.
  test("returns the job to the queue on shutdown, and reports nothing", async () => {
    const errors: SixbErrorContext[] = []
    const { sixb, lakeStorage, queues } = createHost({ errors })
    const worker = await start(sixb)
    const requestedAt = new Date().toISOString()

    await enqueueRetention(queues, requestedAt)
    await eventually(() => lakeStorage.passes.length === 1)

    const stopping = worker.stop()
    lakeStorage.passes[0]!.resolve({ hasMore: true })
    await stopping

    const [redelivered] = await queues.lake.claim({ projectId: PROJECT_ID, workerId: "next" })

    expect(redelivered?.job).toMatchObject({ id: `lake-retention:${requestedAt}`, attempt: 2 })
    expect(errors).toEqual([])
  })
})
