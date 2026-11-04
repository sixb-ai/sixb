import { describe, expect, test } from "bun:test"
import {
  col,
  defineConnector,
  defineDataset,
  definePipeline,
  definePipelineStep,
  defineSync,
  InMemoryQueues,
  InMemoryStorage,
} from "../src"
import { createPrimitiveExecutionRecord } from "../src/execution/durable"
import { dispatchPipelineRun, PipelineRunDispatcher } from "../src/pipelines/run-dispatch"
import { createDefinitionCatalog } from "../src/runtime/definitions"
import { dispatchSyncRun, SyncRunDispatcher } from "../src/syncs/run-dispatch"

const source = defineConnector("source", {
  type: "test",
  connect: () => ({}),
})
const rawOrders = defineDataset("raw.orders", { schema: [col("id", "string")] })
const cleanOrders = defineDataset("clean.orders", { schema: [col("id", "string")] })
const sync = defineSync("sync-orders")
  .from(source)
  .read(() => [])
  .intoDataset(rawOrders)
const step = definePipelineStep("clean-orders")
  .inputs({ orders: rawOrders })
  .output(cleanOrders)
  .run(() => {})
const pipeline = definePipeline("pipeline-orders").then(step)

describe("Sync and Pipeline durable dispatch", () => {
  // Revert queued-run republication / keep-queued handling to lose or terminalize the accepted job.
  test.each([
    false,
    true,
  ])("automatic Sync/Pipeline delivery recovers uncertain enqueue (%s)", async (accepted) => {
    const storage = new InMemoryStorage()
    const queues = new InMemoryQueues()
    const dependencies = {
      id: "test",
      storage,
      queues,
      definitions: {
        syncs: createDefinitionCatalog(new Map([[sync.id, sync]])),
        pipelines: createDefinitionCatalog(new Map([[pipeline.id, pipeline]])),
      },
    }
    const source = { type: "event" as const, eventId: "event" }
    const inputs = { source, correlationId: "correlation" }
    const syncDispatcher = new SyncRunDispatcher(dependencies)
    const pipelineDispatcher = new PipelineRunDispatcher(dependencies)
    function failFirst<TInput, TResult>(enqueue: (input: TInput) => Promise<TResult>) {
      let first = true
      return async (input: TInput): Promise<TResult> => {
        if (first) {
          first = false
          if (accepted) await enqueue(input)
          throw new Error("queue unavailable")
        }
        return enqueue(input)
      }
    }
    queues.syncRuns.enqueue = failFirst(queues.syncRuns.enqueue.bind(queues.syncRuns))
    queues.pipelines.enqueue = failFirst(queues.pipelines.enqueue.bind(queues.pipelines))
    const cases = [
      {
        queue: queues.syncRuns,
        dispatch: () => syncDispatcher.dispatch({ ...inputs, syncId: sync.id, runId: "sync" }),
        read: () => storage.syncRuns.getById({ projectId: "test", id: "sync" }),
      },
      {
        queue: queues.pipelines,
        dispatch: () =>
          pipelineDispatcher.dispatch({ ...inputs, pipelineId: pipeline.id, runId: "pipeline" }),
        read: () => storage.pipelineRuns.getById({ projectId: "test", id: "pipeline" }),
      },
    ]
    for (const entry of cases) {
      await expect(entry.dispatch()).rejects.toThrow("queue unavailable")
      const before = await entry.read()
      expect(before?.status).toBe("queued")
      await entry.dispatch()
      await entry.dispatch()
      expect((await entry.read())?.executionId).toBe(before?.executionId)
      expect(
        await entry.queue.claim({ projectId: "test", workerId: "test", limit: 10 })
      ).toHaveLength(1)
    }
  })
  test("requeues a Sync enqueue failure with the same run and execution identities", async () => {
    const storage = new InMemoryStorage()
    const queues = new InMemoryQueues()
    const enqueue = queues.syncRuns.enqueue.bind(queues.syncRuns)
    let failPublication = true
    queues.syncRuns.enqueue = async (input) => {
      if (failPublication) {
        failPublication = false
        throw new Error("queue unavailable")
      }
      return enqueue(input)
    }
    const dispatch = () =>
      dispatchSyncRun({
        errorReporterHost: {},
        projectId: "project-1",
        sync,
        storage,
        queue: queues.syncRuns,
        runId: "sync-run-1",
        createExecution: async (executionId, runId) =>
          createPrimitiveExecutionRecord({
            id: executionId,
            primitive: { kind: "sync", id: sync.id, runId },
            origin: {
              type: "automatic",
              projectId: "project-1",
              source: { type: "event", eventId: "event-1" },
              correlationId: "correlation-1",
            },
          }),
      })

    await expect(dispatch()).rejects.toThrow("queue unavailable")
    const failed = await storage.syncRuns.getById({
      projectId: "project-1",
      id: "sync-run-1",
    })
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "queue.enqueue_failed",
        retryable: true,
        details: { syncId: sync.id, runId: "sync-run-1", phase: "enqueue" },
      },
    })

    const retried = await dispatch()
    const queued = await storage.syncRuns.getById({
      projectId: "project-1",
      id: "sync-run-1",
    })
    expect(retried).toMatchObject({ runId: "sync-run-1", created: false })
    expect(queued).toMatchObject({
      executionId: failed!.executionId,
      status: "queued",
      startedAt: undefined,
      finishedAt: undefined,
      error: undefined,
    })
    const [job] = await queues.syncRuns.claim({ projectId: "project-1", workerId: "worker-1" })
    expect(job?.job).toMatchObject({ id: "sync-run-1", payload: { runId: "sync-run-1" } })
  })

  test("requeues a Pipeline enqueue failure with the same run and execution identities", async () => {
    const storage = new InMemoryStorage()
    const queues = new InMemoryQueues()
    const enqueue = queues.pipelines.enqueue.bind(queues.pipelines)
    let failPublication = true
    queues.pipelines.enqueue = async (input) => {
      if (failPublication) {
        failPublication = false
        throw new Error("queue unavailable")
      }
      return enqueue(input)
    }
    const dispatch = () =>
      dispatchPipelineRun({
        errorReporterHost: {},
        projectId: "project-1",
        pipeline,
        storage,
        queue: queues.pipelines,
        runId: "pipeline-run-1",
        createExecution: async (executionId, runId) =>
          createPrimitiveExecutionRecord({
            id: executionId,
            primitive: { kind: "pipeline", id: pipeline.id, runId },
            origin: {
              type: "automatic",
              projectId: "project-1",
              source: { type: "schedule", eventId: "event-1" },
              correlationId: "correlation-1",
            },
          }),
      })

    await expect(dispatch()).rejects.toThrow("queue unavailable")
    const failed = await storage.pipelineRuns.getById({
      projectId: "project-1",
      id: "pipeline-run-1",
    })
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "queue.enqueue_failed",
        retryable: true,
        details: { pipelineId: pipeline.id, runId: "pipeline-run-1", phase: "enqueue" },
      },
    })

    const retried = await dispatch()
    const queued = await storage.pipelineRuns.getById({
      projectId: "project-1",
      id: "pipeline-run-1",
    })
    expect(retried).toMatchObject({ runId: "pipeline-run-1", created: false })
    expect(queued).toMatchObject({
      executionId: failed!.executionId,
      status: "queued",
      startedAt: undefined,
      finishedAt: undefined,
      error: undefined,
    })
    const [job] = await queues.pipelines.claim({ projectId: "project-1", workerId: "worker-1" })
    expect(job?.job).toMatchObject({
      id: "pipeline-run-1",
      payload: { runId: "pipeline-run-1" },
    })
  })

  test("rejects a Sync retry with different automatic provenance before republication", async () => {
    const storage = new InMemoryStorage()
    const queues = new InMemoryQueues()
    const enqueue = queues.syncRuns.enqueue.bind(queues.syncRuns)
    queues.syncRuns.enqueue = () => Promise.reject(new Error("queue unavailable"))
    const dispatcher = new SyncRunDispatcher({
      id: "project-1",
      definitions: { syncs: createDefinitionCatalog(new Map([[sync.id, sync]])) },
      storage,
      queues,
    })

    await expect(
      dispatcher.dispatch({
        syncId: sync.id,
        runId: "sync-run-provenance",
        source: { type: "event", eventId: "event-1" },
        correlationId: "correlation-1",
      })
    ).rejects.toThrow("queue unavailable")

    queues.syncRuns.enqueue = enqueue
    await expect(
      dispatcher.dispatch({
        syncId: sync.id,
        runId: "sync-run-provenance",
        source: { type: "event", eventId: "event-2" },
        correlationId: "correlation-2",
      })
    ).rejects.toThrow("different automatic provenance")

    expect(
      await storage.syncRuns.getById({ projectId: "project-1", id: "sync-run-provenance" })
    ).toMatchObject({ status: "queued" })
    expect(await queues.syncRuns.claim({ projectId: "project-1", workerId: "worker-1" })).toEqual(
      []
    )
  })

  test("rejects a Pipeline retry with different automatic provenance before republication", async () => {
    const storage = new InMemoryStorage()
    const queues = new InMemoryQueues()
    const enqueue = queues.pipelines.enqueue.bind(queues.pipelines)
    queues.pipelines.enqueue = () => Promise.reject(new Error("queue unavailable"))
    const dispatcher = new PipelineRunDispatcher({
      id: "project-1",
      definitions: {
        pipelines: createDefinitionCatalog(new Map([[pipeline.id, pipeline]])),
      },
      storage,
      queues,
    })

    await expect(
      dispatcher.dispatch({
        pipelineId: pipeline.id,
        runId: "pipeline-run-provenance",
        source: { type: "schedule", eventId: "event-1" },
        correlationId: "correlation-1",
      })
    ).rejects.toThrow("queue unavailable")

    queues.pipelines.enqueue = enqueue
    await expect(
      dispatcher.dispatch({
        pipelineId: pipeline.id,
        runId: "pipeline-run-provenance",
        source: { type: "schedule", eventId: "event-2" },
        correlationId: "correlation-2",
      })
    ).rejects.toThrow("different automatic provenance")

    expect(
      await storage.pipelineRuns.getById({
        projectId: "project-1",
        id: "pipeline-run-provenance",
      })
    ).toMatchObject({ status: "queued" })
    expect(await queues.pipelines.claim({ projectId: "project-1", workerId: "worker-1" })).toEqual(
      []
    )
  })
})

type AutomaticSourceType = "event" | "schedule"

interface DispatchResult {
  readonly runId: string
  readonly created: boolean
}

interface AutomaticTarget {
  readonly queue: InMemoryQueues["pipelines"] | InMemoryQueues["syncRuns"]
  /** One automatic trigger, with the per-event run id the orchestrator derives. */
  dispatch(eventId: string, sourceType?: AutomaticSourceType): Promise<DispatchResult>
  /** The shared dispatch path a manual request takes. */
  request(runId: string, options?: { readonly commitMessage?: string }): Promise<DispatchResult>
  runIds(status: "queued" | "running"): Promise<readonly string[]>
  start(runId: string): Promise<void>
  jobIds(): Promise<readonly string[]>
}

function automaticRunId(kind: "pipeline" | "sync", eventId: string): string {
  return `${kind}:schedule:on-change:event:${eventId}`
}

function createAutomaticTarget(kind: "pipeline" | "sync"): AutomaticTarget {
  const projectId = "test"
  const storage = new InMemoryStorage()
  const queues = new InMemoryQueues()
  const dependencies = {
    id: projectId,
    storage,
    queues,
    definitions: {
      syncs: createDefinitionCatalog(new Map([[sync.id, sync]])),
      pipelines: createDefinitionCatalog(new Map([[pipeline.id, pipeline]])),
    },
  }
  const requestExecution =
    (primitive: { readonly kind: "pipeline" | "sync"; readonly id: string }) =>
    async (executionId: string, runId: string) =>
      createPrimitiveExecutionRecord({
        id: executionId,
        primitive: { ...primitive, runId },
        origin: {
          type: "automatic",
          projectId,
          source: { type: "event", eventId: `request:${runId}` },
          correlationId: `request:${runId}`,
        },
      })

  if (kind === "pipeline") {
    const dispatcher = new PipelineRunDispatcher(dependencies)

    return {
      queue: queues.pipelines,
      dispatch: (eventId, sourceType = "event") =>
        dispatcher.dispatch({
          pipelineId: pipeline.id,
          runId: automaticRunId(kind, eventId),
          source: { type: sourceType, eventId },
          correlationId: eventId,
        }),
      request: (runId) =>
        dispatchPipelineRun({
          errorReporterHost: {},
          projectId,
          pipeline,
          storage,
          queue: queues.pipelines,
          runId,
          createExecution: requestExecution({ kind, id: pipeline.id }),
        }),
      runIds: async (status) => {
        const { runs } = await storage.pipelineRuns.list({ projectId, statuses: [status] })
        return runs.map((run) => run.id)
      },
      start: async (runId) => {
        await storage.pipelineRuns.start({ projectId, id: runId })
      },
      jobIds: async () => {
        const claimed = await queues.pipelines.claim({ projectId, workerId: "test", limit: 50 })
        return claimed.map(({ job }) => job.id)
      },
    }
  }

  const dispatcher = new SyncRunDispatcher(dependencies)

  return {
    queue: queues.syncRuns,
    dispatch: (eventId, sourceType = "event") =>
      dispatcher.dispatch({
        syncId: sync.id,
        runId: automaticRunId(kind, eventId),
        source: { type: sourceType, eventId },
        correlationId: eventId,
      }),
    request: (runId, options = {}) =>
      dispatchSyncRun({
        errorReporterHost: {},
        projectId,
        sync,
        storage,
        queue: queues.syncRuns,
        runId,
        commitMessage: options.commitMessage,
        createExecution: requestExecution({ kind, id: sync.id }),
      }),
    runIds: async (status) => {
      const { runs } = await storage.syncRuns.list({ projectId, statuses: [status] })
      return runs.map((run) => run.id)
    },
    start: async (runId) => {
      await storage.syncRuns.start({ projectId, id: runId })
    },
    jobIds: async () => {
      const claimed = await queues.syncRuns.claim({ projectId, workerId: "test", limit: 50 })
      return claimed.map(({ job }) => job.id)
    },
  }
}

// Drop `joinQueuedRun: true` from a dispatcher to watch these fail: every trigger queues its run.
describe.each(["pipeline", "sync"] as const)("automatic %s dispatch", (kind) => {
  const firstRunId = automaticRunId(kind, "event-1")
  const secondRunId = automaticRunId(kind, "event-2")

  test.each([
    "event",
    "schedule",
  ] as const)("joins the run that has not started for a burst of %s triggers", async (sourceType) => {
    const target = createAutomaticTarget(kind)

    const results: DispatchResult[] = []
    for (const eventId of ["event-1", "event-2", "event-3"]) {
      results.push(await target.dispatch(eventId, sourceType))
    }

    // Joining does not compare provenance: the run keeps the first trigger's execution.
    expect(results).toMatchObject([
      { runId: firstRunId, created: true },
      { runId: firstRunId, created: false },
      { runId: firstRunId, created: false },
    ])
    expect(await target.runIds("queued")).toEqual([firstRunId])
    expect(await target.jobIds()).toEqual([firstRunId])
  })

  test("queues one more run for triggers that arrive while a run is running", async () => {
    const target = createAutomaticTarget(kind)

    await target.dispatch("event-1")
    await target.start(firstRunId)

    expect(await target.dispatch("event-2")).toMatchObject({ runId: secondRunId, created: true })
    expect(await target.dispatch("event-3")).toMatchObject({ runId: secondRunId, created: false })
    expect(await target.runIds("running")).toEqual([firstRunId])
    expect(await target.runIds("queued")).toEqual([secondRunId])
  })

  // Unchanged by joining: the lookup of the trigger's own run comes first.
  test("returns its own run to a redelivered trigger while another run waits", async () => {
    const target = createAutomaticTarget(kind)

    await target.dispatch("event-1")
    await target.start(firstRunId)
    await target.dispatch("event-2")

    expect(await target.dispatch("event-1")).toMatchObject({ runId: firstRunId, created: false })
    expect(await target.runIds("running")).toEqual([firstRunId])
    expect(await target.runIds("queued")).toEqual([secondRunId])
  })

  // Return the joined run without publishing it to watch this fail: the lost job stays lost.
  test("republishes the job of the run it joins", async () => {
    const target = createAutomaticTarget(kind)
    const enqueue = target.queue.enqueue.bind(target.queue)
    target.queue.enqueue = () => Promise.reject(new Error("queue unavailable"))

    const failed = await target.dispatch("event-1").catch((error: unknown) => error)
    expect(failed).toMatchObject({ message: "queue unavailable" })
    expect(await target.runIds("queued")).toEqual([firstRunId])

    target.queue.enqueue = enqueue
    expect(await target.dispatch("event-2")).toMatchObject({ runId: firstRunId, created: false })
    expect(await target.jobIds()).toEqual([firstRunId])
  })

  // Default `joinQueuedRun` to true in `dispatch*Run` to watch this fail.
  test("never joins from a manual request", async () => {
    const target = createAutomaticTarget(kind)

    await target.dispatch("event-1")

    expect(await target.request("manual-run")).toMatchObject({
      runId: "manual-run",
      created: true,
    })
    expect(await target.runIds("queued")).toHaveLength(2)
  })
})

describe("automatic Sync dispatch", () => {
  // Drop the request match in `findQueuedSyncRun` to watch this join the manual run.
  test("does not join a waiting run queued with another request payload", async () => {
    const target = createAutomaticTarget("sync")

    await target.request("manual-run", { commitMessage: "manual import" })

    expect(await target.dispatch("event-1")).toMatchObject({
      runId: automaticRunId("sync", "event-1"),
      created: true,
    })
  })
})
