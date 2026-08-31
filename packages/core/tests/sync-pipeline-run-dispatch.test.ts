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
    ).toMatchObject({ status: "failed", error: { code: "queue.enqueue_failed" } })
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
    ).toMatchObject({ status: "failed", error: { code: "queue.enqueue_failed" } })
    expect(await queues.pipelines.claim({ projectId: "project-1", workerId: "worker-1" })).toEqual(
      []
    )
  })
})
