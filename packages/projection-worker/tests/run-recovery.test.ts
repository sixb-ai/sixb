import { expect, setSystemTime, test } from "bun:test"
import {
  col,
  type DatasetRow,
  defineDataset,
  defineObjectType,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { ProjectionRunDispatcher } from "@sixb/core/internal/projections"
import { republishLostRuns } from "@sixb/core/internal/workers"
import type { ReadDatasetRowsInput } from "@sixb/core/lake-storage"
import type { Storage } from "@sixb/core/storage"
import { RecoveryGate, runRunRecoveryContractSuite } from "@sixb/core/testing"
import { ProjectionWorker } from "../src"

const LEASE_MS = 15 * 60_000
const LONGEST_RETRY_BACKOFF_MS = 5 * 60_000
const JOB_ON_ITS_WAY_MS = 30_000

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const rooms = defineDataset("rooms", {
  schema: [col("room_id", "string"), col("room_name", "string")],
})

const roomProjection = defineProjection("rooms-projection", Room)
  .fromDataset(rooms)
  .properties({ id: "room_id", name: "room_name" })

/** Tells a test when a delivery has nothing left to do, which `stop` would otherwise decide for it. */
class WatchedProjectionWorker extends ProjectionWorker {
  ended: Promise<void> = Promise.resolve()

  protected override execute(...args: Parameters<ProjectionWorker["execute"]>): Promise<void> {
    const execution = super.execute(...args)
    this.ended = execution.then(
      () => {},
      () => {}
    )
    return execution
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await condition())) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** A lake whose first read of the rooms blocks halfway, and which counts the reads. */
class BlockingLakeStorage extends InMemoryLakeStorage {
  readonly gate = new RecoveryGate()
  reads = 0

  override async *readRows(input: ReadDatasetRowsInput): AsyncIterable<DatasetRow> {
    this.reads += 1
    for await (const row of super.readRows(input)) {
      await this.gate.wait(input.signal)
      yield row
    }
  }
}

function createHost(lakeStorage: InMemoryLakeStorage, storage: Storage = new InMemoryStorage()) {
  return new SixbHost({
    id: "projection-recovery",
    ontology: [Room],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage,
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    datasets: [rooms],
    projections: [roomProjection],
  })
}

/** Dispatches a projection of one committed version, and tells which run took it. */
async function dispatchRooms(host: SixbHost, lakeStorage: InMemoryLakeStorage): Promise<string> {
  await lakeStorage.createDataset(rooms)
  const write = await lakeStorage.beginWrite({
    dataset: rooms,
    mode: "snapshot",
    producer: { kind: "sync", id: "rooms-sync", runId: "sync-run" },
  })
  await write.writeRows([{ room_id: "r1", room_name: "Kitchen" }])
  const version = await write.commit()

  const dispatched = await new ProjectionRunDispatcher(host).dispatch({
    projectionId: roomProjection.id,
    datasetVersion: {
      datasetId: version.datasetId,
      versionId: version.versionId,
      createdAt: version.createdAt.toISOString(),
    },
  })

  return dispatched.runId
}

runRunRecoveryContractSuite("Projection", async () => {
  const lakeStorage = new BlockingLakeStorage()
  const host = createHost(lakeStorage)

  const projectionRuns = host.storage.projectionRuns!
  let runId = ""
  const readRun = () => projectionRuns.getById({ projectId: host.id, id: runId })

  const first = new WatchedProjectionWorker(host)

  const runWorkerUntilOver = async () => {
    const worker = new ProjectionWorker(host)
    await worker.start()
    try {
      await waitFor(async () => (await readRun())?.status !== "running")
    } finally {
      await worker.stop()
    }
  }

  return {
    afterCrash: "resumes",
    afterShutdown: "resumes",
    leaseMs: LEASE_MS,

    async begin() {
      runId = await dispatchRooms(host, lakeStorage)

      await first.start()
      await lakeStorage.gate.reached
    },
    unblock: () => lakeStorage.gate.open(),
    firstExecutionEnded: () => first.ended,
    stop: () => first.stop(),

    async redeliver() {
      setSystemTime(new Date(Date.now() + LONGEST_RETRY_BACKOFF_MS))
      await runWorkerUntilOver()
    },

    async deliverDuplicate() {
      const held = new Promise<void>((resolve) => {
        const retry = host.queues.projections.retry.bind(host.queues.projections)
        host.queues.projections.retry = async (input) => {
          await retry(input)
          resolve()
        }
      })
      await host.queues.projections.enqueue({
        projectId: host.id,
        jobs: [
          {
            id: `${runId}:duplicate`,
            type: "projection.run.requested",
            payload: { runId },
          },
        ],
      })

      const worker = new ProjectionWorker(host)
      await worker.start()
      await held
      await worker.stop()
    },

    status: async () => String((await readRun())?.status),
    workStarts: () => lakeStorage.reads,

    async outputCopies() {
      const { objects } = await host.storage.objects.list({
        projectId: host.id,
        objectTypeId: "Room",
      })
      return objects.length
    },
    dispose: () => first.stop(),
  }
})

// Drop `republishLapsedProjections` to watch this run sit `running` with nothing left to take it.
test("a run whose job is gone comes back through the recovery pass", async () => {
  const lakeStorage = new BlockingLakeStorage()
  const host = createHost(lakeStorage)
  const id = await dispatchRooms(host, lakeStorage)

  const stopped = new ProjectionWorker(host)
  await stopped.start()
  await lakeStorage.gate.reached
  await stopped.stop()

  // The queue died with its process. Storage and the lake did not.
  lakeStorage.gate.open()
  const restarted = createHost(lakeStorage, host.storage)

  const pass = await republishLostRuns({
    projectId: restarted.id,
    storage: restarted.storage,
    queues: restarted.queues,
    events: restarted.events,
    now: new Date(Date.now() + JOB_ON_ITS_WAY_MS),
  })
  expect(pass).toEqual({ republished: 1, settled: 0 })

  const worker = new ProjectionWorker(restarted)
  await worker.start()
  await waitFor(async () => {
    const run = await restarted.storage.projectionRuns!.getById({ projectId: restarted.id, id })
    return run?.status === "succeeded"
  })
  await worker.stop()
})
