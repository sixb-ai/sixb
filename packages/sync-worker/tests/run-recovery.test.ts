import { describe, expect, setSystemTime, test } from "bun:test"
import {
  col,
  defineConnector,
  defineDataset,
  defineSync,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type SixbErrorHandler,
  SixbHost,
  type SixbHostOptions,
  type SyncDefinition,
} from "@sixb/core"
import { republishLostRuns } from "@sixb/core/internal/workers"
import { RecoveryGate, runRunRecoveryContractSuite } from "@sixb/core/testing"
import { SyncWorker } from "../src"

const projectId = "sync-recovery"
const runId = "run-1"
const LEASE_MS = 15 * 60_000
const RETRY_BACKOFF_MS = 1_000

const orders = defineDataset("orders", { schema: [col("id", "string")] })

const erpDb = defineConnector("erpDb", {
  type: "sql",
  connect() {
    return {}
  },
})

/** Tells a test when a delivery has nothing left to do, which `stop` would otherwise decide for it. */
class WatchedSyncWorker extends SyncWorker {
  ended: Promise<void> = Promise.resolve()

  protected override execute(...args: Parameters<SyncWorker["execute"]>): Promise<void> {
    const execution = super.execute(...args)
    this.ended = execution.then(
      () => {},
      () => {}
    )
    return execution
  }
}

function createHost(
  sync: SyncDefinition,
  onError?: SixbErrorHandler,
  parts: Partial<Pick<SixbHostOptions, "storage" | "lakeStorage" | "queues">> = {}
) {
  return new SixbHost({
    id: projectId,
    ontology: [],
    connectors: [erpDb],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    datasets: [orders],
    syncs: [sync],
    onError,
    ...parts,
  })
}

async function queueRun(host: SixbHost, id = runId) {
  const syncRuns = host.storage.syncRuns!
  await host.storage.executions.create({
    id: `exec:${id}`,
    projectId,
    executor: { type: "primitive", kind: "sync", runId: id },
    source: { type: "schedule", eventId: `event:${id}` },
    correlationId: `correlation:${id}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "sync", id: "orders-sync", runId: id },
    },
  })
  await syncRuns.queue({
    id,
    projectId,
    executionId: `exec:${id}`,
    syncId: "orders-sync",
    datasetId: orders.id,
    mode: "append",
  })
  await host.queues.syncRuns.enqueue({
    projectId,
    jobs: [{ id, type: "sync.run.requested", payload: { runId: id } }],
  })
}

/** The first commit lands, and the connection dies before its answer gets back. */
function loseFirstCommitReply(host: SixbHost): void {
  let lost = false
  const beginWrite = host.lakeStorage.beginWrite.bind(host.lakeStorage)

  host.lakeStorage.beginWrite = async (input) => {
    const session = await beginWrite(input)
    const commit = session.commit.bind(session)

    session.commit = async (commitInput) => {
      const committed = await commit(commitInput)
      if (lost) return committed

      lost = true
      throw new Error("connection lost during COMMIT")
    }
    return session
  }
}

/** Dies right after the commit, before anything records it. */
function dieAfterCommit(host: SixbHost): RecoveryGate {
  const died = new RecoveryGate()
  const beginWrite = host.lakeStorage.beginWrite.bind(host.lakeStorage)

  host.lakeStorage.beginWrite = async (input) => {
    const session = await beginWrite(input)
    const commit = session.commit.bind(session)

    session.commit = async (commitInput) => {
      const committed = await commit(commitInput)
      await died.wait()
      return committed
    }
    return session
  }

  return died
}

async function runEnded(host: SixbHost): Promise<boolean> {
  const status = await runStatus(host)
  return status !== "queued" && status !== "running"
}

async function readRows(host: SixbHost) {
  if (!(await host.lakeStorage.getLatestVersion(orders.id))) return []

  const rows: unknown[] = []
  for await (const row of host.lakeStorage.readRows({ datasetId: orders.id })) rows.push(row)
  return rows
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await condition())) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function runWorkerUntil(host: SixbHost, done: () => boolean | Promise<boolean>) {
  const worker = new SyncWorker(host)
  await worker.start()
  try {
    await waitFor(done)
  } finally {
    await worker.stop()
  }
}

async function readRuns(host: SixbHost) {
  const { runs } = await host.storage.syncRuns!.list({ projectId, order: "asc" })
  return runs
}

/** Executions that died in turn, as each next delivery finds them: their leases are long gone. */
async function spendAttempts(host: SixbHost, count: number) {
  for (let crash = 1; crash <= count; crash += 1) {
    await host.storage.syncRuns!.startOrReclaim({
      projectId,
      id: runId,
      execution: { token: `crash-${crash}`, queueLeaseExpiresAt: new Date(0) },
    })
  }
}

async function runStatus(host: SixbHost, id = runId): Promise<string | undefined> {
  return (await host.storage.syncRuns!.getById({ projectId, id }))?.status
}

runRunRecoveryContractSuite("Sync", async () => {
  const gate = new RecoveryGate()
  let starts = 0

  const sync = defineSync("orders-sync", { mode: "append" })
    .from(erpDb)
    .read(async function* (_client, { signal }) {
      starts += 1
      yield { id: "order-1" }
      await gate.wait(signal)
      yield { id: "order-2" }
    })
    .intoDataset(orders)

  const host = createHost(sync)
  const first = new WatchedSyncWorker(host)

  let jobsSettled = 0
  const queue = host.queues.syncRuns
  const retry = queue.retry.bind(queue)
  queue.retry = async (input) => {
    jobsSettled += 1
    return retry(input)
  }

  return {
    afterCrash: "resumes",
    afterShutdown: "resumes",
    leaseMs: LEASE_MS,

    async begin() {
      await queueRun(host)
      await first.start()
      await gate.reached
    },
    unblock: () => gate.open(),
    firstExecutionEnded: () => first.ended,
    stop: () => first.stop(),

    redeliver: () => runWorkerUntil(host, async () => (await runStatus(host)) !== "running"),

    async deliverDuplicate() {
      await queue.enqueue({
        projectId,
        jobs: [{ id: `${runId}:join:other`, type: "sync.run.requested", payload: { runId } }],
      })
      await runWorkerUntil(host, () => jobsSettled > 0)
    },

    status: async () => String(await runStatus(host)),
    workStarts: () => starts,
    outputCopies: async () => (await readRows(host)).length / 2,
    dispose: () => first.stop(),
  }
})

describe("SyncWorker recovery", () => {
  // Drop `prepareCommit` from the sync's `beforeCommit` to watch the checkpoint go missing, and the
  // lookup in `runSyncJob` to watch the rows land twice.
  test("records a commit that landed before the crash, with what it read", async () => {
    const reads: (string | undefined)[] = []
    const sync = defineSync("orders-sync", { mode: "append" })
      .checkpoint<string>()
      .from(erpDb)
      .read(async function* (_client, { checkpoint, setCheckpoint }) {
        reads.push(checkpoint)
        yield { id: `order-after-${checkpoint ?? "start"}` }
        setCheckpoint("next")
      })
      .intoDataset(orders)
    const host = createHost(sync)
    await queueRun(host)

    const syncRuns = host.storage.syncRuns!
    const died = dieAfterCommit(host)

    const dead = new SyncWorker(host)
    await dead.start()
    await died.reached

    expect(await runStatus(host)).toBe("running")
    expect(await readRows(host)).toHaveLength(1)

    setSystemTime(new Date(Date.now() + LEASE_MS + 1))
    await runWorkerUntil(host, async () => (await runStatus(host)) === "succeeded")
    setSystemTime()

    expect(reads).toEqual([undefined])
    expect(await readRows(host)).toHaveLength(1)

    const run = await syncRuns.getById({ projectId, id: runId })
    expect(run?.output?.datasetId).toBe(orders.id)
    expect(run?.rowsRead).toBe(1)
    expect(await host.events.read({ types: ["dataset.version.committed"] })).toHaveLength(1)

    await queueRun(host, "run-2")
    await runWorkerUntil(host, async () => (await runStatus(host, "run-2")) === "succeeded")

    expect(reads).toEqual([undefined, "next"])
    expect(await readRows(host)).toHaveLength(2)

    died.open()
    await dead.stop()
  })

  test("reads again from the last succeeded checkpoint when the commit never landed", async () => {
    const gate = new RecoveryGate()
    const reads: (string | undefined)[] = []
    const sync = defineSync("orders-sync", { mode: "append" })
      .checkpoint<string>()
      .from(erpDb)
      .read(async function* (_client, { checkpoint, setCheckpoint, signal }) {
        reads.push(checkpoint)
        yield { id: "order-1" }
        setCheckpoint("moved-before-the-crash")
        await gate.wait(signal)
      })
      .intoDataset(orders)
    const host = createHost(sync)
    await queueRun(host)

    const dead = new SyncWorker(host)
    await dead.start()
    await gate.reached
    expect(await readRows(host)).toEqual([])

    setSystemTime(new Date(Date.now() + LEASE_MS + 1))
    await runWorkerUntil(host, async () => (await runStatus(host)) === "succeeded")
    setSystemTime()

    expect(reads).toEqual([undefined, undefined])
    expect(await readRows(host)).toHaveLength(1)

    await dead.stop()
  })

  // Skip `landedCommitBehind` in the catch of `runSyncJob` to watch the rows land twice.
  test("a commit that landed and answered with an error is a commit", async () => {
    const reads: (string | undefined)[] = []
    const sync = defineSync("orders-sync", { mode: "append" })
      .checkpoint<string>()
      .from(erpDb)
      .read(async function* (_client, { checkpoint, setCheckpoint }) {
        reads.push(checkpoint)
        yield { id: `order-after-${checkpoint ?? "start"}` }
        setCheckpoint("next")
      })
      .intoDataset(orders)
    const host = createHost(sync)
    loseFirstCommitReply(host)
    await queueRun(host)

    await runWorkerUntil(host, () => runEnded(host))

    expect(await runStatus(host)).toBe("succeeded")
    expect(await readRows(host)).toEqual([{ id: "order-after-start" }])
    expect((await readRuns(host))[0]).toMatchObject({ attempt: 1, rowsRead: 1 })

    await queueRun(host, "run-2")
    await runWorkerUntil(host, async () => (await runStatus(host, "run-2")) === "succeeded")

    expect(reads).toEqual([undefined, "next"])
    expect(await readRows(host)).toHaveLength(2)
  })

  // Ask the lake only when it can answer to watch this run fail with its commit in the dataset.
  test("a lake that cannot say whether the commit landed is asked again", async () => {
    const sync = defineSync("orders-sync", { mode: "append" })
      .from(erpDb)
      .read(async function* () {
        yield { id: "order-1" }
      })
      .intoDataset(orders)
    const host = createHost(sync)
    loseFirstCommitReply(host)
    await queueRun(host)

    let unreachable = true
    const listVersions = host.lakeStorage.listVersions.bind(host.lakeStorage)
    host.lakeStorage.listVersions = async (input) => {
      if (!unreachable) return listVersions(input)

      unreachable = false
      throw new Error("lake unreachable")
    }

    let retried = false
    const retry = host.queues.syncRuns.retry.bind(host.queues.syncRuns)
    host.queues.syncRuns.retry = async (input) => {
      await retry(input)
      retried = true
    }

    await runWorkerUntil(host, () => retried)
    expect(await runStatus(host)).toBe("running")

    setSystemTime(new Date(Date.now() + RETRY_BACKOFF_MS))
    await runWorkerUntil(host, async () => (await runStatus(host)) === "succeeded")
    setSystemTime()

    expect(await readRows(host)).toHaveLength(1)
  })

  // Give up ahead of the lookups, the one on resuming and the one in the catch of `runSyncJob`, to
  // watch this commit end up `failed`.
  test("a run out of attempts still records the commit that landed", async () => {
    const reads: (string | undefined)[] = []
    const sync = defineSync("orders-sync", { mode: "append" })
      .checkpoint<string>()
      .from(erpDb)
      .read(async function* (_client, { checkpoint, setCheckpoint }) {
        reads.push(checkpoint)
        yield { id: "order-1" }
        setCheckpoint("next")
      })
      .intoDataset(orders)
    const host = createHost(sync)
    await queueRun(host)

    const died = dieAfterCommit(host)
    const dead = new SyncWorker(host)
    await dead.start()
    await died.reached

    setSystemTime(new Date(Date.now() + LEASE_MS + 1))
    await spendAttempts(host, 4)

    await runWorkerUntil(host, async () => (await runStatus(host)) !== "running")
    setSystemTime()

    expect(await runStatus(host)).toBe("succeeded")
    expect(await readRows(host)).toHaveLength(1)

    died.open()
    await dead.stop()

    await queueRun(host, "run-2")
    await runWorkerUntil(host, async () => (await runStatus(host, "run-2")) === "succeeded")

    expect(reads).toEqual([undefined, "next"])
  })

  // Put `requireSync` ahead of the lookups, the one on resuming and the one in the catch of
  // `runSyncJob`, to watch the deploy fail a landed commit.
  test("a deploy that changes the sync does not lose the commit it finds", async () => {
    const definition = (mode: "append" | "snapshot") =>
      defineSync("orders-sync", { mode })
        .from(erpDb)
        .read(async function* () {
          yield { id: "order-1" }
        })
        .intoDataset(orders)

    const host = createHost(definition("append"))
    await queueRun(host)

    const died = dieAfterCommit(host)
    const dead = new SyncWorker(host)
    await dead.start()
    await died.reached

    const deployed = createHost(definition("snapshot"), undefined, {
      storage: host.storage,
      lakeStorage: host.lakeStorage,
      queues: host.queues,
    })

    setSystemTime(new Date(Date.now() + LEASE_MS + 1))
    await runWorkerUntil(deployed, async () => (await runStatus(deployed)) !== "running")
    setSystemTime()

    expect(await runStatus(deployed)).toBe("succeeded")
    expect(await readRows(deployed)).toHaveLength(1)

    died.open()
    await dead.stop()
  })

  // Drop the `commitPreparedAt` check in `findLandedCommit` to watch a long sync look through a
  // busy dataset for a commit it never made.
  test("a run that never reached its commit does not ask the lake for it", async () => {
    const gate = new RecoveryGate()
    const sync = defineSync("orders-sync", { mode: "append" })
      .from(erpDb)
      .read(async function* (_client, { signal }) {
        yield { id: "order-1" }
        await gate.wait(signal)
      })
      .intoDataset(orders)
    const host = createHost(sync)
    await queueRun(host)

    const dead = new SyncWorker(host)
    await dead.start()
    await gate.reached

    let lookups = 0
    const listVersions = host.lakeStorage.listVersions.bind(host.lakeStorage)
    host.lakeStorage.listVersions = async (input) => {
      lookups += 1
      return listVersions(input)
    }

    gate.open()
    setSystemTime(new Date(Date.now() + LEASE_MS + 1))
    await runWorkerUntil(host, async () => (await runStatus(host)) === "succeeded")
    setSystemTime()

    expect(lookups).toBe(0)

    await dead.stop()
  })

  // Skip the pass to watch the second run wait for good, with nothing left to wake it.
  test("a restart that loses the queue does not wedge the sync", async () => {
    let held = true
    const gate = new RecoveryGate()
    const sync = defineSync("orders-sync", { mode: "append" })
      .from(erpDb)
      .read(async function* (_client, { signal }) {
        yield { id: "order-1" }
        if (held) await gate.wait(signal)
      })
      .intoDataset(orders)
    const host = createHost(sync)
    await queueRun(host)

    const stopped = new SyncWorker(host)
    await stopped.start()
    await gate.reached
    await stopped.stop()

    expect(await runStatus(host)).toBe("running")

    // Memory queues die with the process. Persistent storage and the lake do not.
    held = false
    const restarted = createHost(sync, undefined, {
      storage: host.storage,
      lakeStorage: host.lakeStorage,
    })
    await queueRun(restarted, "run-2")

    await republishLostRuns({
      projectId: restarted.id,
      storage: restarted.storage,
      queues: restarted.queues,
      events: restarted.events,
      now: new Date(Date.now() + 60_000),
    })

    await runWorkerUntil(
      restarted,
      async () => (await runStatus(restarted, "run-2")) === "succeeded"
    )

    expect(await runStatus(restarted)).toBe("succeeded")
  })

  // Remove the attempt check from `RunWorker.execute` to watch this run forever.
  test("gives up on a run that keeps taking its worker down", async () => {
    const reports: string[] = []
    const gate = new RecoveryGate()
    const sync = defineSync("orders-sync", { mode: "append" })
      .from(erpDb)
      .read(async function* (_client, { signal }) {
        await gate.wait(signal)
        yield { id: "order-1" }
      })
      .intoDataset(orders)
    const host = createHost(sync, (error) => {
      reports.push(error.message)
    })
    await queueRun(host)

    await spendAttempts(host, 5)

    await runWorkerUntil(host, async () => (await runStatus(host)) === "failed")

    expect(reports).toEqual([expect.stringContaining("given up after 5 attempts")])
  })

  // Write `cancelled` from the abort path of `runSyncJob` to watch a deploy cancel runs again.
  test("a cancel recorded on the run ends it, and a worker being stopped never records one", async () => {
    const gate = new RecoveryGate()
    const sync = defineSync("orders-sync", { mode: "append" })
      .from(erpDb)
      .read(async function* (_client, { signal }) {
        await gate.wait(signal)
        yield { id: "order-1" }
      })
      .intoDataset(orders)
    const host = createHost(sync)
    await queueRun(host)

    const worker = new WatchedSyncWorker(host)
    await worker.start()
    await gate.reached

    await host.storage.syncRuns!.finish({ projectId, id: runId, status: "cancelled" })

    gate.open()
    await worker.ended

    expect(await runStatus(host)).toBe("cancelled")
    expect(await readRows(host)).toEqual([])

    await worker.stop()
  })

  // Commit without `guardLatestVersion` to watch the sleeping execution append the rows twice.
  test("refuses the commit of an execution that slept past its own fence", async () => {
    let reads = 0
    const sync = defineSync("orders-sync", { mode: "append" })
      .from(erpDb)
      .read(async function* () {
        reads += 1
        yield { id: "order-1" }
      })
      .intoDataset(orders)
    const host = createHost(sync)
    await queueRun(host)

    // It passed its fence, and sleeps right before the commit.
    const asleep = new RecoveryGate()
    const beginWrite = host.lakeStorage.beginWrite.bind(host.lakeStorage)
    host.lakeStorage.beginWrite = async (input) => {
      const session = await beginWrite(input)
      const commit = session.commit.bind(session)
      session.commit = async (commitInput) => {
        await asleep.wait()
        return commit(commitInput)
      }
      return session
    }

    const sleeping = new WatchedSyncWorker(host)
    await sleeping.start()
    await asleep.reached

    setSystemTime(new Date(Date.now() + LEASE_MS + 1))
    await runWorkerUntil(host, async () => (await runStatus(host)) === "succeeded")
    setSystemTime()

    expect(await readRows(host)).toHaveLength(1)

    asleep.open()
    await sleeping.ended

    expect(reads).toBe(2)
    expect(await readRows(host)).toHaveLength(1)
    expect(await runStatus(host)).toBe("succeeded")

    await sleeping.stop()
  })

  // Commit before `findLandedCommit` runs in `prepareCommit` to watch both commits land.
  test("records the commit of an execution that woke up just before its own", async () => {
    const asleep = new RecoveryGate()
    const reading = new RecoveryGate()
    let reads = 0
    const sync = defineSync("orders-sync", { mode: "append" })
      .checkpoint<string>()
      .from(erpDb)
      .read(async function* (_client, { setCheckpoint }) {
        reads += 1
        yield { id: "order-1" }
        setCheckpoint(`read-${reads}`)
        if (reads === 2) await reading.wait()
      })
      .intoDataset(orders)
    const host = createHost(sync)
    await queueRun(host)

    const beginWrite = host.lakeStorage.beginWrite.bind(host.lakeStorage)
    host.lakeStorage.beginWrite = async (input) => {
      const session = await beginWrite(input)
      const commit = session.commit.bind(session)
      session.commit = async (commitInput) => {
        if (reads === 1) await asleep.wait()
        return commit(commitInput)
      }
      return session
    }

    const sleeping = new WatchedSyncWorker(host)
    await sleeping.start()
    await asleep.reached

    setSystemTime(new Date(Date.now() + LEASE_MS + 1))
    const second = new SyncWorker(host)
    await second.start()
    await reading.reached

    // The sleeper's commit lands while the second execution reads what it already read.
    reads = 1
    asleep.open()
    await sleeping.ended
    expect(await readRows(host)).toHaveLength(1)

    reads = 2
    reading.open()
    await waitFor(async () => (await runStatus(host)) === "succeeded")
    setSystemTime()

    expect(await readRows(host)).toHaveLength(1)
    expect(
      (await host.storage.syncRuns!.getById({ projectId, id: runId }))?.checkpoint
    ).toMatchObject({ value: "read-1" })

    await second.stop()
    await sleeping.stop()
  })

  // Drop the `sibling` check from the stores to watch the second run read the first one's rows, and
  // `wakeNextRun` to watch it sit out its slow recheck.
  test("runs one run of a sync at a time, and a trigger that comes meanwhile joins the next", async () => {
    const gate = new RecoveryGate()
    const reads: (string | undefined)[] = []
    const sync = defineSync("orders-sync", { mode: "append" })
      .checkpoint<string>()
      .from(erpDb)
      .read(async function* (_client, { checkpoint, setCheckpoint, signal }) {
        reads.push(checkpoint)
        yield { id: `after-${checkpoint ?? "start"}` }
        await gate.wait(signal)
        setCheckpoint("moved")
      })
      .intoDataset(orders)
    const host = createHost(sync)
    await queueRun(host)
    await queueRun(host, "run-2")

    let held = 0
    const retry = host.queues.syncRuns.retry.bind(host.queues.syncRuns)
    host.queues.syncRuns.retry = async (input) => {
      held += 1
      return retry(input)
    }

    const worker = new SyncWorker(host, { concurrency: 2 })
    await worker.start()
    await gate.reached
    await waitFor(() => held > 0)

    expect(reads).toEqual([undefined])
    expect(await runStatus(host, "run-2")).toBe("queued")

    // The first run's end wakes the second: its own job is parked for a minute.
    gate.open()
    await waitFor(async () => (await runStatus(host, "run-2")) === "succeeded")
    await worker.stop()

    expect(reads).toEqual([undefined, "moved"])
  })

  // Skip `onRunFinished` on the failure path of `runSyncJob` to watch a schedule on this sync never
  // hear of it.
  test("a run given up on is failed for everyone who reads the outcome", async () => {
    const sync = defineSync("orders-sync", { mode: "append" })
      .from(erpDb)
      .read(async function* () {
        yield { id: "order-1" }
      })
      .intoDataset(orders)
    const host = createHost(sync)
    await queueRun(host)

    await spendAttempts(host, 5)

    await runWorkerUntil(host, async () => (await runStatus(host)) === "failed")

    const [finished] = await host.events.read({ types: ["sync.run.finished"] })
    expect(finished?.payload).toMatchObject({ runId, status: "failed" })

    const run = await host.storage.syncRuns!.getById({ projectId, id: runId })
    expect(run?.error?.message).toContain("stopped 5 times")
  })
})
