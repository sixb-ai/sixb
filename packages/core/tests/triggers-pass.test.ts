import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
import {
  col,
  defineDataset,
  definePipeline,
  definePipelineStep,
  defineSchedule,
  events,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { PipelineRunDispatcher } from "@sixb/core/internal/pipelines"
import { ORPHANED_RUN_AFTER_MS } from "@sixb/core/internal/storage"
import { republishLostRuns } from "@sixb/core/internal/workers"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { queueTestPipelineRun, startTestPipelineRun, startTestRun } from "@sixb/core/testing"
import { LakeChangeFeed } from "../src/maintenance/passes/lake-change-feed"
import {
  type DatasetTrigger,
  type TriggersPassInput,
  triggersPass,
} from "../src/maintenance/passes/triggers-pass"

const INTERVAL_MS = 30_000

const orders = defineDataset("raw.orders", { schema: [col("id", "string")] })
const report = defineDataset("orders.report", { schema: [col("id", "string")] })

const ordersUpdated = defineSchedule("orders.updated").on(events.dataset(orders).updated())
const daily = defineSchedule("orders.daily").cron("0 2 * * *")

const buildReport = definePipeline("build-report")
  .when(ordersUpdated)
  .then(
    definePipelineStep("report")
      .inputs({ orders })
      .output(report)
      .run(() => {})
  )

const TRIGGER: DatasetTrigger = {
  pipelineId: buildReport.id,
  scheduleId: ordersUpdated.id,
  datasetId: orders.id,
}

const signal = new AbortController().signal

/** Versions sort by time: each commit gets a second of its own. */
let clock = Date.parse("2026-11-07T12:00:00.000Z")

function tick(): void {
  clock += 1_000
  setSystemTime(new Date(clock))
}

beforeEach(tick)

afterEach(() => {
  setSystemTime()
})

function createScene() {
  const storage = new InMemoryStorage()
  const lakeStorage = new InMemoryLakeStorage()
  const queues = new InMemoryQueues()
  const host = new SixbHost({
    id: "project",
    ontology: [],
    datasets: [orders, report],
    pipelines: [buildReport],
    schedules: [ordersUpdated, daily],
    broker: new InMemoryBroker(),
    queues,
    storage,
    lakeStorage,
    blobStorage: new InMemoryBlobStorage(),
  })
  const dispatcher = new PipelineRunDispatcher(host)

  /** Storage's facade takes no spies, so the reads are counted on their way through. */
  const reads = { latestRuns: 0, steps: 0 }
  const pipelineRuns: TriggersPassInput["pipelineRuns"] = {
    listLatestByPipelineIds(input) {
      reads.latestRuns += 1
      return storage.pipelineRuns.listLatestByPipelineIds(input)
    },
    listSteps(input) {
      reads.steps += 1
      return storage.pipelineRuns.listSteps(input)
    },
  }

  const createPass = (triggers: readonly DatasetTrigger[] = [TRIGGER]) => {
    let now = Date.now()

    const pass = triggersPass({
      projectId: "project",
      dispatcher,
      triggers,
      lakeStorage,
      pipelineRuns,
      feed: new LakeChangeFeed({ lakeStorage, projectId: "project", freshForMs: 0 }),
      now: () => now,
    })

    return {
      run(signal: AbortSignal, at = Date.now()) {
        now = at
        return pass.run(signal)
      },
    }
  }

  /** One that sees every commit as old enough that its event should have arrived. */
  const later = () => Date.now() + 2 * INTERVAL_MS

  async function commit(id: string): Promise<DatasetVersion> {
    tick()
    await lakeStorage.createDataset(orders)
    const write = await lakeStorage.beginWrite({ dataset: orders, mode: "snapshot" })
    await write.writeRows([{ id }])
    return write.commit()
  }

  /** A version that records new provenance over the same rows: no `updated()` for it. */
  async function commitSameRows(row: string, marker: string): Promise<DatasetVersion> {
    tick()
    const write = await lakeStorage.beginWrite({
      dataset: orders,
      mode: "snapshot",
      inputs: [{ datasetId: marker, versionId: marker }],
    })
    await write.writeRows([{ id: row }])
    return write.commit()
  }

  async function run(
    id: string,
    status: "succeeded" | "failed" | "cancelled" | "running",
    read: readonly DatasetVersion[] = []
  ): Promise<void> {
    tick()
    await startTestPipelineRun(storage, {
      id,
      projectId: "project",
      pipelineId: buildReport.id,
    })

    for (const [index, version] of read.entries()) {
      await storage.pipelineRuns.startStep({
        id: `${id}:step:${index}`,
        projectId: "project",
        pipelineRunId: id,
        pipelineId: buildReport.id,
        stepId: `step-${index}`,
        datasetId: report.id,
        mode: "snapshot",
        inputs: [{ datasetId: orders.id, versionId: version.versionId }],
      })
    }

    if (status === "running") return
    if (status === "failed") {
      const error = {
        code: "pipeline.step_failed" as const,
        message: "boom",
        retryable: false,
        at: new Date().toISOString(),
      }
      await storage.pipelineRuns.finish({ id, projectId: "project", status, error })
      return
    }
    await storage.pipelineRuns.finish({ id, projectId: "project", status })
  }

  const publishedJobs = async () =>
    queues.pipelines.claim({ projectId: "project", workerId: "test", limit: 100 })

  /** What an older version leaves behind: a running run that holds no lease. */
  function forgetExecution(id: string): void {
    const { runs } = storage.pipelineRuns as unknown as { runs: Map<string, object> }
    const key = `project:${id}`

    runs.set(key, { ...runs.get(key), execution: undefined })
  }

  return {
    storage,
    queues,
    lakeStorage,
    dispatcher,
    forgetExecution,
    reads,
    createPass,
    later,
    commit,
    commitSameRows,
    run,
    publishedJobs,
  }
}

async function queuedRuns(storage: InMemoryStorage) {
  const { runs } = await storage.pipelineRuns.list({ projectId: "project", statuses: ["queued"] })
  return runs
}

describe("beside the `runs` pass", () => {
  function runsPass(scene: ReturnType<typeof createScene>) {
    return republishLostRuns({
      projectId: "project",
      storage: scene.storage,
      queues: scene.queues,
      events: { emit: async () => {} },
      now: new Date(Date.now() + 2 * INTERVAL_MS),
    })
  }

  // Have the `triggers` pass treat a lost run as not active to watch it start a second run.
  test("a queued run that lost its job gets its job back, and no second run", async () => {
    const scene = createScene()
    const first = await scene.commit("order-1")
    await scene.run("last", "succeeded", [first])
    await queueTestPipelineRun(scene.storage, {
      id: "lost",
      projectId: "project",
      pipelineId: buildReport.id,
    })
    await scene.commit("order-2")
    const reconciler = scene.createReconciler()

    await reconciler.pass(signal, scene.later())
    await expect(runsPass(scene)).resolves.toMatchObject({ republished: 1 })
    await reconciler.pass(signal, scene.later())

    expect((await queuedRuns(scene.storage)).map((run) => run.id)).toEqual(["lost"])
    expect((await scene.publishedJobs()).map((claimed) => claimed.job.id)).toEqual(["lost"])
  })

  // Have the `triggers` pass count a cancelled run as having read to watch this change be lost.
  test("a run of an older version that gets ended fires its trigger once", async () => {
    const scene = createScene()
    const first = await scene.commit("order-1")
    await scene.run("last", "succeeded", [first])
    await scene.commit("order-2")
    await scene.run("old", "running")

    await scene.forgetExecution("old")
    tick()
    setSystemTime(new Date(Date.now() + ORPHANED_RUN_AFTER_MS))

    const reconciler = scene.createReconciler()
    await reconciler.pass(signal, scene.later())
    expect(await queuedRuns(scene.storage)).toEqual([])

    await expect(runsPass(scene)).resolves.toMatchObject({ settled: 1 })

    await reconciler.pass(signal, scene.later())
    await reconciler.pass(signal, scene.later())

    expect(await queuedRuns(scene.storage)).toHaveLength(1)
  })
})

describe("triggersPass", () => {
  test("dispatches a commit whose event was lost, once", async () => {
    // Red check: leave out the `dispatch` call in `settleTrigger`; nothing is queued.
    const scene = createScene()
    const first = await scene.commit("order-1")
    await scene.run("last", "succeeded", [first])
    const second = await scene.commit("order-2")
    const pass = scene.createPass()

    await pass.run(signal, scene.later())
    await pass.run(signal, scene.later())

    const queued = await queuedRuns(scene.storage)
    expect(queued).toHaveLength(1)

    const execution = await scene.storage.executions.getById({
      projectId: "project",
      id: queued[0]!.executionId,
    })
    expect(execution?.source).toEqual({
      type: "datasetVersion",
      datasetId: orders.id,
      versionId: second.versionId,
    })
    expect(await scene.publishedJobs()).toHaveLength(1)
  })

  test("a commit that lands after the first pass reaches the feed", async () => {
    // Red check: skip marking `changes.versions` unsettled in `pass`; this commit is never seen.
    const scene = createScene()
    const first = await scene.commit("order-1")
    await scene.run("last", "succeeded", [first])
    const pass = scene.createPass()
    await pass.run(signal, scene.later())
    expect(await queuedRuns(scene.storage)).toEqual([])

    await scene.commit("order-2")
    await pass.run(signal, scene.later())

    expect(await queuedRuns(scene.storage)).toHaveLength(1)
  })

  test("a restart finds what was committed while no orchestrator ran", async () => {
    const scene = createScene()
    const first = await scene.commit("order-1")
    await scene.run("last", "succeeded", [first])
    await scene.createPass().run(signal, scene.later())
    await scene.commit("order-2")

    await scene.createPass().run(signal, scene.later())

    expect(await queuedRuns(scene.storage)).toHaveLength(1)
  })

  test("a run that read the newest version settles the trigger", async () => {
    const scene = createScene()
    await scene.commit("order-1")
    const newest = await scene.commit("order-2")
    await scene.run("last", "succeeded", [newest])

    await scene.createPass().run(signal, scene.later())

    expect(await queuedRuns(scene.storage)).toEqual([])
  })

  describe("the last run decides", () => {
    test("queued: nothing, until it ended without reading the change", async () => {
      // Red check: return true for an active run in `settleTrigger`; the trigger is forgotten
      // while the run is in flight, and the commit it did not read is lost.
      const scene = createScene()
      const first = await scene.commit("order-1")
      await queueTestPipelineRun(scene.storage, {
        id: "waiting",
        projectId: "project",
        pipelineId: buildReport.id,
      })
      await scene.commit("order-2")
      const pass = scene.createPass()

      await pass.run(signal, scene.later())
      expect((await queuedRuns(scene.storage)).map((run) => run.id)).toEqual(["waiting"])

      await startTestRun(scene.storage.pipelineRuns, { id: "waiting", projectId: "project" })
      await scene.storage.pipelineRuns.startStep({
        id: "waiting:step",
        projectId: "project",
        pipelineRunId: "waiting",
        pipelineId: buildReport.id,
        stepId: "report",
        datasetId: report.id,
        mode: "snapshot",
        inputs: [{ datasetId: orders.id, versionId: first.versionId }],
      })
      await scene.storage.pipelineRuns.finish({
        id: "waiting",
        projectId: "project",
        status: "succeeded",
      })

      await pass.run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toHaveLength(1)
    })

    test("running: nothing while it runs", async () => {
      const scene = createScene()
      await scene.commit("order-1")
      await scene.run("in-flight", "running")
      await scene.commit("order-2")

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toEqual([])
    })

    test("failed: what it read counts as read, so it is not retried", async () => {
      // Red check: leave failed runs out of `hasRead`; every pass starts a new run.
      const scene = createScene()
      const version = await scene.commit("order-1")
      await scene.run("failed", "failed", [version])

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toEqual([])
    })

    test("failed before reading the dataset: it covers what existed when it started", async () => {
      const scene = createScene()
      await scene.commit("order-1")
      await scene.run("failed-early", "failed")

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toEqual([])
    })

    test("failed: a version newer than what it read still fires", async () => {
      const scene = createScene()
      const read = await scene.commit("order-1")
      await scene.run("failed", "failed", [read])
      await scene.commit("order-2")

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toHaveLength(1)
    })

    test("cancelled: does not count, so the run before it decides", async () => {
      // Red check: read `counted` from `latest` alone; the cancelled run hides the older read.
      const scene = createScene()
      const read = await scene.commit("order-1")
      await scene.run("finished", "succeeded", [read])
      const unread = await scene.commit("order-2")
      await scene.run("stopped", "cancelled", [unread])

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toHaveLength(1)
    })

    test("cancelled: a run before it that read the change settles the trigger", async () => {
      const scene = createScene()
      const version = await scene.commit("order-1")
      await scene.run("finished", "succeeded", [version])
      await scene.run("stopped", "cancelled", [version])

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toEqual([])
    })

    test("cancelled with nothing before it: the trigger was consumed, so it fires", async () => {
      const scene = createScene()
      await scene.commit("order-1")
      await scene.run("stopped", "cancelled")

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toHaveLength(1)
    })

    test("cancelled again: the next recovery is a new run", async () => {
      // Red check: drop `latest.id` from `recoveredRunId`; the dispatch finds the cancelled run
      // under the same id and starts nothing.
      const scene = createScene()
      await scene.commit("order-1")
      await scene.run("stopped", "cancelled")
      const pass = scene.createPass()
      await pass.run(signal, scene.later())
      const [recovered] = await queuedRuns(scene.storage)

      tick()
      await startTestRun(scene.storage.pipelineRuns, { id: recovered!.id, projectId: "project" })
      await scene.storage.pipelineRuns.finish({
        id: recovered!.id,
        projectId: "project",
        status: "cancelled",
      })
      // Reproduce: return true after `dispatch` in `settleTrigger`; with no new commit, nothing
      // looks at this trigger again.
      await pass.run(signal, scene.later())

      const [next] = await queuedRuns(scene.storage)
      expect(next?.id).toBeDefined()
      expect(next?.id).not.toBe(recovered!.id)
    })

    test("none: a first run stays the user's or the next event's", async () => {
      const scene = createScene()
      await scene.commit("order-1")

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toEqual([])
    })
  })

  describe("what counts as a change", () => {
    test("a version that changed no row is no trigger", async () => {
      // Red check: return true from `firesUpdated`; the no-op version fires.
      const scene = createScene()
      const version = await scene.commit("order-1")
      await scene.run("last", "succeeded", [version])
      await scene.commitSameRows("order-1", "provenance-only")

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toEqual([])
    })

    test("a no-op on top of a change the run never read still fires", async () => {
      // Red check: return null from `readChange` when the latest version changed nothing, which is
      // all a feed summary could say; the change underneath is lost.
      const scene = createScene()
      const read = await scene.commit("order-1")
      await scene.run("last", "succeeded", [read])
      await scene.commit("order-2")
      await scene.commitSameRows("order-2", "provenance-only")

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toHaveLength(1)
    })

    test("a run that read a no-op on top of the change has read the change", async () => {
      const scene = createScene()
      await scene.commit("order-1")
      await scene.commit("order-2")
      const noOp = await scene.commitSameRows("order-2", "provenance-only")
      await scene.run("last", "succeeded", [noOp])

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toEqual([])
    })

    test("every step must have read the change", async () => {
      // Red check: use `some` in `hasRead`; the step on the older version goes unnoticed.
      const scene = createScene()
      const older = await scene.commit("order-1")
      const newest = await scene.commit("order-2")
      await scene.run("mixed", "succeeded", [older, newest])

      await scene.createPass().run(signal, scene.later())

      expect(await queuedRuns(scene.storage)).toHaveLength(1)
    })
  })

  test("leaves a fresh commit to its event, then fires when it stayed lost", async () => {
    // Red check: drop the interval check in `settleTrigger`; the first pass fires beside the event.
    const scene = createScene()
    const first = await scene.commit("order-1")
    await scene.run("last", "succeeded", [first])
    const second = await scene.commit("order-2")
    const pass = scene.createPass()

    await pass.run(signal, second.createdAt.getTime() + INTERVAL_MS - 1)
    expect(await queuedRuns(scene.storage)).toEqual([])

    await pass.run(signal, second.createdAt.getTime() + INTERVAL_MS)
    expect(await queuedRuns(scene.storage)).toHaveLength(1)
  })

  test("keeps a trigger it could not dispatch, and says so", async () => {
    const scene = createScene()
    const first = await scene.commit("order-1")
    await scene.run("last", "succeeded", [first])
    await scene.commit("order-2")
    const pass = scene.createPass()

    const dispatch = spyOn(scene.dispatcher, "dispatch")
    dispatch.mockRejectedValueOnce(new Error("queue unavailable"))
    const failure = await pass.run(signal, scene.later()).catch((error) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors[0].message).toContain(`pipelineId=${buildReport.id}`)

    await pass.run(signal, scene.later())
    expect(await queuedRuns(scene.storage)).toHaveLength(1)
  })

  test("starts over when the cursor stops being a position in the lake", async () => {
    const scene = createScene()
    const first = await scene.commit("order-1")
    await scene.run("last", "succeeded", [first])
    const pass = scene.createPass()
    await pass.run(signal, scene.later())
    await scene.commit("order-2")

    const feed = spyOn(scene.lakeStorage, "listLatestVersionsSince")
    feed.mockResolvedValueOnce(null)
    await pass.run(signal, scene.later())

    expect(await queuedRuns(scene.storage)).toHaveLength(1)
  })

  describe("cost", () => {
    test("an idle pass reads the feed and nothing else", async () => {
      // Red check: mark every trigger unsettled on each pass; the idle passes read the lake and
      // the runs again.
      const scene = createScene()
      const version = await scene.commit("order-1")
      await scene.run("last", "succeeded", [version])
      const pass = scene.createPass()
      await pass.run(signal, scene.later())

      expect(scene.reads).toEqual({ latestRuns: 1, steps: 1 })

      const feed = spyOn(scene.lakeStorage, "listLatestVersionsSince")
      const latest = spyOn(scene.lakeStorage, "getLatestVersion")

      await pass.run(signal, scene.later())
      await pass.run(signal, scene.later())

      expect(feed).toHaveBeenCalledTimes(2)
      expect(latest).not.toHaveBeenCalled()
      expect(scene.reads).toEqual({ latestRuns: 1, steps: 1 })
    })

    test("many pipelines on one dataset cost one read of each kind", async () => {
      // Red check: call `readPipelines` per trigger in `settle`; it counts ten.
      const scene = createScene()
      const version = await scene.commit("order-1")
      await scene.run("last", "succeeded", [version])
      const triggers = Array.from({ length: 10 }, (_, index) => ({
        ...TRIGGER,
        pipelineId: index === 0 ? buildReport.id : `other-${index}`,
      }))
      const pass = scene.createPass(triggers)

      const latest = spyOn(scene.lakeStorage, "getLatestVersion")

      await pass.run(signal, scene.later())

      expect(latest).toHaveBeenCalledTimes(1)
      expect(scene.reads).toEqual({ latestRuns: 1, steps: 1 })
    })
  })
})
