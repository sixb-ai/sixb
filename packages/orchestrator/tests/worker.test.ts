import { afterEach, describe, expect, jest, test } from "bun:test"
import {
  col,
  defineConnector,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineSchedule,
  defineSync,
  defineWorkflow,
  defineWorkflowStep,
  events,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import {
  DomainEventService,
  type EventDraft,
  type StableEventEnvelope,
} from "@sixb/core/internal/events"
import type { ProjectionDispatchDescriptor } from "@sixb/core/internal/projections"
import { WorkflowRunDispatcher } from "@sixb/core/internal/workflows"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { compileRoutes } from "../src/compile-routes"
import { ProjectionDispatchReconciler } from "../src/projection-dispatch-reconciler"
import type {
  OrchestratorRoutes,
  PipelineDispatcherPort,
  ProjectionDispatcherPort,
  ProjectionDispatchInput,
  ProjectionReconciliationPorts,
  SyncDispatcherPort,
  WorkflowDispatcherPort,
  WorkflowDispatchInput,
} from "../src/types"
import { OrchestratorWorker } from "../src/worker"

const PROJECT_ID = "test-project"

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true }), prop("amount", "double")],
})

const highValueInvoice = defineSchedule("invoice.high-value")
  .on(events.object(Invoice).updated())
  .where((event) => event.object.p.amount.gt(500))

const captureInvoice = defineWorkflowStep("capture-invoice")
  .input({ invoiceId: "string", amount: "double" })
  .output({})
  .run(() => ({}))

const highValueInvoiceWorkflow = defineWorkflow("notify-high-value-invoice")
  .input({ invoiceId: "string", amount: "double" })
  .when(highValueInvoice, ({ event }) => ({
    invoiceId: event.object.primaryId,
    amount: event.object.p.amount,
  }))
  .then(captureInvoice)

const emptyStep = defineWorkflowStep("empty-step")
  .input({})
  .output({})
  .run(() => ({}))

const connector = defineConnector("source", {
  type: "test",
  connect() {
    return {}
  },
})
const rawInvoices = defineDataset("raw.invoices", { schema: [col("id", "string")] })
const cleanInvoices = defineDataset("clean.invoices", { schema: [col("id", "string")] })

function createEvents(projectId = PROJECT_ID, broker = new InMemoryBroker()): DomainEventService {
  return new DomainEventService({ projectId, broker })
}

function makeScheduleTriggeredEvent(
  scheduleId: string,
  occurrenceAt = "2026-04-18T02:00:00.000Z"
): EventDraft {
  return {
    type: "schedule.triggered",
    payload: {
      scheduleId,
      occurrenceAt,
      triggeredAt: occurrenceAt,
      occurrenceKey: `${scheduleId}:${occurrenceAt}`,
    },
  }
}

function makeInvoiceUpdatedEvent(
  amountBefore: number,
  amountAfter: number,
  projectId = PROJECT_ID
): StableEventEnvelope {
  return {
    id: `invoice-updated-${projectId}-${amountBefore}-${amountAfter}`,
    schemaVersion: 1,
    projectId,
    occurredAt: "2026-04-18T02:00:00.000Z",
    correlationId: `correlation-${amountBefore}-${amountAfter}`,
    origin: { kind: "runtime", requestId: `request-${amountBefore}-${amountAfter}` },
    executor: { type: "request", requestId: `request-${amountBefore}-${amountAfter}` },
    commitId: `commit-${amountBefore}-${amountAfter}`,
    commitOrdinal: 0,
    type: "object.updated",
    topic: "objects",
    partitionKey: "Invoice:inv-1",
    payload: {
      objectTypeId: "Invoice",
      primaryId: "inv-1",
      properties: { id: "inv-1", amount: amountAfter },
      propertyChanges: {
        amount: { operation: "updated", before: amountBefore, after: amountAfter },
      },
    },
  }
}

function makeDatasetVersionCommittedEvent(versionId = "v-1"): EventDraft {
  return {
    type: "dataset.version.committed",
    payload: {
      datasetId: rawInvoices.id,
      versionId,
      createdAt: "2026-04-18T02:00:00.000Z",
      producer: { kind: "sync", id: "source-sync", runId: "run-1" },
    },
  }
}

function eventWorkflowRoutes(): OrchestratorRoutes {
  return compileRoutes({
    schedules: [highValueInvoice],
    syncs: [],
    pipelines: [],
    workflows: [highValueInvoiceWorkflow],
  })
}

/**
 * Polls between event-loop turns rather than on a timer, so it also works while timers are faked.
 * The clock is frozen then, and the test's own timeout bounds the wait instead.
 */
async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Timed out waiting for condition.")
}

/** Lets queued work run for a few event-loop turns, to show that something did not happen. */
async function waitForTurns(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const originalError = console.error
  console.error = () => {}
  try {
    return await run()
  } finally {
    console.error = originalError
  }
}

function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error("Expected function to throw.")
}

const workers: OrchestratorWorker[] = []

// Revert the returned processing promise in consumeBatches: all retained batches enter at once.
// Drop `from: "earliest"` from consumeRetainedEventSchedules: the events published before start are
// never delivered. Skip the retry in retryBatch: the failed batch's 99 siblings are never queued.
// The broker delivers retained events in pages of 100, so 150 events make two batches.
test("retained event schedules catch up with backpressure and replay a failed enqueue", async () => {
  const broker = new InMemoryBroker()
  const queues = new InMemoryQueues()
  const eventRuntime = createEvents(PROJECT_ID, broker)
  const host = new SixbHost({
    id: PROJECT_ID,
    ontology: [Invoice],
    workflows: [highValueInvoiceWorkflow],
    schedules: [highValueInvoice],
    broker,
    queues,
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
  })
  await eventRuntime.publishEnvelopes(
    Array.from({ length: 150 }, (_, i) => makeInvoiceUpdatedEvent(0, 700 + i))
  )
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const enqueue = queues.workflows.enqueue.bind(queues.workflows)
  let attempts = 0
  let acknowledged = 0
  queues.workflows.enqueue = async (params) => {
    if (++attempts === 1) {
      await blocked
      throw new Error("temporary queue failure")
    }
    const jobs = await enqueue(params)
    acknowledged += jobs.length
    return jobs
  }
  const subscribe = eventRuntime.subscribe.bind(eventRuntime)
  let deliveries = 0
  eventRuntime.subscribe = (input, handler) =>
    subscribe(input, (batch) => {
      deliveries += 1
      return handler(batch)
    })
  jest.useFakeTimers()
  try {
    await quietly(async () => {
      await startWorker(
        eventRuntime,
        queues,
        eventWorkflowRoutes(),
        PROJECT_ID,
        undefined,
        new WorkflowRunDispatcher(host)
      )
      await waitFor(() => attempts > 0)
      await waitForTurns(20)
      expect(deliveries).toBe(1)
      release()
      // The failed batch waits out a retry backoff before it is dispatched again.
      await waitFor(() => jest.getTimerCount() === 1)
      jest.runOnlyPendingTimers()
      await waitFor(() => acknowledged === 150)
    })
    expect(attempts).toBe(151)
    expect(deliveries).toBe(2)
    expect(
      await queues.workflows.claim({ projectId: PROJECT_ID, workerId: "test", limit: 500 })
    ).toHaveLength(150)
  } finally {
    release()
    jest.useRealTimers()
  }
})

afterEach(async () => {
  for (const worker of workers) await worker.stop().catch(() => {})
  workers.length = 0
})

async function startWorker(
  eventRuntime: DomainEventService,
  queues: InMemoryQueues,
  routes: OrchestratorRoutes,
  projectId = PROJECT_ID,
  projections?: {
    readonly dispatcher: ProjectionDispatcherPort
    readonly reconciliation: ProjectionReconciliationPorts
  },
  workflowDispatcher = createTestWorkflowRunDispatcher(queues, undefined, projectId)
): Promise<OrchestratorWorker> {
  const worker = new OrchestratorWorker({
    projectId,
    events: eventRuntime,
    queues,
    routes,
    dispatchers: {
      syncs: createTestSyncRunDispatcher(queues, projectId),
      pipelines: createTestPipelineRunDispatcher(queues, projectId),
      workflows: workflowDispatcher,
      ...(projections === undefined ? {} : { projections: projections.dispatcher }),
    },
    ...(projections === undefined ? {} : { projectionReconciliation: projections.reconciliation }),
  })
  workers.push(worker)
  await worker.start()
  return worker
}

function createTestSyncRunDispatcher(
  queues: InMemoryQueues,
  projectId = PROJECT_ID
): SyncDispatcherPort {
  return {
    async dispatch(input) {
      const [job] = await queues.syncRuns.enqueue({
        projectId,
        jobs: [
          {
            id: input.runId,
            type: "sync.run.requested",
            payload: { runId: input.runId },
            metadata: input.metadata,
          },
        ],
      })
      return {
        syncId: input.syncId,
        runId: input.runId,
        queuedAt: job!.createdAt,
        jobId: job!.id,
        created: true,
      }
    },
  }
}

function createTestPipelineRunDispatcher(
  queues: InMemoryQueues,
  projectId = PROJECT_ID
): PipelineDispatcherPort {
  return {
    async dispatch(input) {
      const [job] = await queues.pipelines.enqueue({
        projectId,
        jobs: [
          {
            id: input.runId,
            type: "pipeline.run.requested",
            payload: { runId: input.runId },
            metadata: input.metadata,
          },
        ],
      })
      return {
        pipelineId: input.pipelineId,
        runId: input.runId,
        queuedAt: job!.createdAt,
        jobId: job!.id,
        created: true,
      }
    },
  }
}

function createTestWorkflowRunDispatcher(
  queues: InMemoryQueues,
  calls?: WorkflowDispatchInput[],
  projectId = PROJECT_ID
): WorkflowDispatcherPort {
  return {
    async dispatch(input) {
      calls?.push(structuredClone(input))
      const [job] = await queues.workflows.enqueue({
        projectId,
        jobs: [
          {
            id: input.runId,
            type: "workflow.run.requested",
            payload: { runId: input.runId },
            metadata: input.metadata,
          },
        ],
      })
      return {
        workflowId: input.workflowId,
        runId: input.runId,
        queuedAt: job!.createdAt,
        jobId: job!.id,
        created: true,
      }
    },
  }
}

function createTestProjectionDispatcher(
  calls: ProjectionDispatchInput[],
  dispatch?: (input: ProjectionDispatchInput) => Promise<void>
): ProjectionDispatcherPort {
  return {
    async dispatch(input) {
      await dispatch?.(input)
      calls.push(structuredClone(input))
      return {
        projectionId: input.projectionId,
        runId: `projection:${input.projectionId}:${input.datasetVersion.versionId}`,
        queuedAt: input.datasetVersion.createdAt,
        created: true,
      }
    },
  }
}

async function noLakeChanges() {
  return { cursor: "0", versions: [] }
}

const noProjectionRuns: ProjectionReconciliationPorts["projectionRuns"] = {
  async list() {
    return { runs: [], hasMore: false, total: 0 }
  },
}

function invoiceProjectionDescriptor(
  overrides: Partial<ProjectionDispatchDescriptor> = {}
): ProjectionDispatchDescriptor {
  return {
    projectionId: "invoice-projection",
    projectionKind: "object",
    protocol: "replacement",
    datasetId: rawInvoices.id,
    ontologyRevision: "ontology-1",
    projectionRevision: "projection-1",
    ownershipHash: "ownership-1",
    ...overrides,
  } as ProjectionDispatchDescriptor
}

async function commitInvoiceDatasetVersion(lakeStorage: InMemoryLakeStorage) {
  await lakeStorage.createDataset(rawInvoices)
  const write = await lakeStorage.beginWrite({
    dataset: rawInvoices,
    mode: "snapshot",
    producer: { kind: "sync", id: "source-sync", runId: "run-1" },
  })
  await write.writeRows([{ id: "invoice-1" }])
  return write.commit()
}

describe("OrchestratorWorker", () => {
  test("cron schedule enqueues deterministic sync and workflow jobs with provenance", async () => {
    const daily = defineSchedule("daily").cron("0 2 * * *")
    const sync = defineSync("sync-invoices")
      .when(daily)
      .from(connector)
      .read(() => [])
      .intoDataset(rawInvoices)
    const workflow = defineWorkflow("daily-workflow").input({}).when(daily).then(emptyStep)
    const routes = compileRoutes({
      schedules: [daily],
      syncs: [sync],
      pipelines: [],
      workflows: [workflow],
    })
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    const dispatches: WorkflowDispatchInput[] = []
    await startWorker(
      eventRuntime,
      queues,
      routes,
      PROJECT_ID,
      undefined,
      createTestWorkflowRunDispatcher(queues, dispatches)
    )

    const [sourceEvent] = await eventRuntime.append({
      events: [makeScheduleTriggeredEvent(daily.id)],
    })

    await waitFor(() => dispatches.length === 1)
    const syncJobs = await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "sync" })
    const workflowJobs = await queues.workflows.claim({
      projectId: PROJECT_ID,
      workerId: "workflow",
    })

    expect(syncJobs[0]!.job.payload.runId).toBe(
      `sync:${sync.id}:schedule:${daily.id}:event:${sourceEvent!.id}`
    )
    expect(workflowJobs[0]!.job.payload).toEqual({
      runId: `workflow:${workflow.id}:schedule:${daily.id}:event:${sourceEvent!.id}`,
    })
    expect(dispatches).toEqual([
      expect.objectContaining({
        workflowId: workflow.id,
        input: {},
        scheduleId: daily.id,
        source: { type: "schedule", eventId: sourceEvent!.id },
        correlationId: sourceEvent!.correlationId ?? sourceEvent!.id,
      }),
    ])
  })

  // Events reach a subscription in publication order, so once the edge is dispatched, the earlier
  // events have been judged too.
  test("event schedules fire only on their own project's false-to-true transitions", async () => {
    const broker = new InMemoryBroker()
    const eventRuntime = createEvents(PROJECT_ID, broker)
    const otherEvents = createEvents("other-project", broker)
    const queues = new InMemoryQueues()
    const dispatches: WorkflowDispatchInput[] = []
    await startWorker(
      eventRuntime,
      queues,
      eventWorkflowRoutes(),
      PROJECT_ID,
      undefined,
      createTestWorkflowRunDispatcher(queues, dispatches)
    )

    await otherEvents.publishEnvelopes([makeInvoiceUpdatedEvent(400, 700, "other-project")])
    await eventRuntime.publishEnvelopes([makeInvoiceUpdatedEvent(600, 700)])
    const [sourceEvent] = await eventRuntime.publishEnvelopes([makeInvoiceUpdatedEvent(400, 700)])
    await waitFor(() => dispatches.length > 0)

    expect(dispatches).toEqual([
      expect.objectContaining({
        workflowId: highValueInvoiceWorkflow.id,
        input: { invoiceId: "inv-1", amount: 700 },
        scheduleId: highValueInvoice.id,
        source: { type: "event", eventId: sourceEvent!.id },
        correlationId: sourceEvent!.correlationId ?? sourceEvent!.id,
      }),
    ])
    const claimed = await queues.workflows.claim({ projectId: PROJECT_ID, workerId: "edge" })
    expect(claimed.map((job) => job.job.payload)).toEqual([
      {
        runId: `workflow:${highValueInvoiceWorkflow.id}:schedule:${highValueInvoice.id}:event:${sourceEvent!.id}`,
      },
    ])
  })

  test("one dataset event schedule fans out to all three consumer queues", async () => {
    const datasetSchedule = defineSchedule("raw-invoices-updated").on(
      events.dataset(rawInvoices).updated()
    )
    const sync = defineSync("sync-copy")
      .when(datasetSchedule)
      .from(connector)
      .read(() => [])
      .intoDataset(rawInvoices)
    const pipeline = definePipeline("clean-invoices")
      .when(datasetSchedule)
      .then(
        definePipelineStep("clean")
          .inputs({ invoices: rawInvoices })
          .output(cleanInvoices)
          .run(() => {})
      )
    const workflow = defineWorkflow("inspect-invoices")
      .input({})
      .when(datasetSchedule)
      .then(emptyStep)
    const routes = compileRoutes({
      schedules: [datasetSchedule],
      syncs: [sync],
      pipelines: [pipeline],
      workflows: [workflow],
    })
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    await startWorker(eventRuntime, queues, routes)

    const [sourceEvent] = await eventRuntime.append({
      events: [makeDatasetVersionCommittedEvent()],
    })
    await waitFor(async () => {
      const syncJobs = await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "sync" })
      const pipelineJobs = await queues.pipelines.claim({
        projectId: PROJECT_ID,
        workerId: "pipeline",
      })
      const workflowJobs = await queues.workflows.claim({
        projectId: PROJECT_ID,
        workerId: "workflow",
      })
      if (syncJobs.length === 0 || pipelineJobs.length === 0 || workflowJobs.length === 0) {
        return false
      }
      expect(syncJobs[0]!.job.payload.runId).toContain(`event:${sourceEvent!.id}`)
      expect(pipelineJobs[0]!.job.payload.runId).toContain(`event:${sourceEvent!.id}`)
      expect(workflowJobs[0]!.job.payload.runId).toContain(`event:${sourceEvent!.id}`)
      return true
    })
  })

  test("sync outcome selectors only dispatch the selected status", async () => {
    const upstream = defineSync("upstream")
      .from(connector)
      .read(() => [])
      .intoDataset(rawInvoices)
    const succeeded = defineSchedule("upstream-succeeded").on(events.sync(upstream).succeeded())
    const workflow = defineWorkflow("after-upstream").input({}).when(succeeded).then(emptyStep)
    const routes = compileRoutes({
      schedules: [succeeded],
      syncs: [],
      pipelines: [],
      workflows: [workflow],
    })
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    const dispatches: WorkflowDispatchInput[] = []
    await startWorker(
      eventRuntime,
      queues,
      routes,
      PROJECT_ID,
      undefined,
      createTestWorkflowRunDispatcher(queues, dispatches)
    )

    await eventRuntime.append({
      events: [
        {
          type: "sync.run.finished",
          payload: { syncId: upstream.id, runId: "failed-run", status: "failed" },
        },
      ],
    })
    await eventRuntime.append({
      correlationId: "upstream-correlation",
      events: [
        {
          type: "sync.run.finished",
          payload: { syncId: upstream.id, runId: "ok-run", status: "succeeded" },
        },
      ],
    })
    // Both events share one ordered subscription: the failed run was judged first.
    await waitFor(() => dispatches.length > 0)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]?.correlationId).toBe("upstream-correlation")
    expect(
      await queues.workflows.claim({ projectId: PROJECT_ID, workerId: "ok", limit: 10 })
    ).toHaveLength(1)
  })

  test("dataset commits pass the immutable version to the Projection dispatcher", async () => {
    const descriptor = invoiceProjectionDescriptor()
    const routes = compileRoutes({
      schedules: [],
      syncs: [],
      pipelines: [],
      projections: [descriptor],
    })
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    const dispatches: ProjectionDispatchInput[] = []
    await startWorker(eventRuntime, queues, routes, PROJECT_ID, {
      dispatcher: createTestProjectionDispatcher(dispatches),
      reconciliation: { lakeStorage: new InMemoryLakeStorage(), projectionRuns: noProjectionRuns },
    })

    const [sourceEvent] = await eventRuntime.append({
      events: [makeDatasetVersionCommittedEvent("version-42")],
    })
    await waitFor(() => dispatches.length === 1)
    expect(dispatches[0]).toMatchObject({
      projectionId: descriptor.projectionId,
      datasetVersion: {
        datasetId: rawInvoices.id,
        versionId: "version-42",
        createdAt: "2026-04-18T02:00:00.000Z",
      },
      metadata: {
        sourceEventId: sourceEvent!.id,
        sourceEventType: "dataset.version.committed",
      },
    })
  })

  test("reconciles a committed dataset version when its live event is missing", async () => {
    const descriptor = invoiceProjectionDescriptor()
    const routes = compileRoutes({
      schedules: [],
      syncs: [],
      pipelines: [],
      projections: [descriptor],
    })
    const lakeStorage = new InMemoryLakeStorage()
    const version = await commitInvoiceDatasetVersion(lakeStorage)
    const queues = new InMemoryQueues()
    const dispatches: ProjectionDispatchInput[] = []

    await startWorker(createEvents(), queues, routes, PROJECT_ID, {
      dispatcher: createTestProjectionDispatcher(dispatches),
      reconciliation: { lakeStorage, projectionRuns: noProjectionRuns },
    })

    await waitFor(() => dispatches.length === 1)
    expect(dispatches[0]).toMatchObject({
      datasetVersion: {
        datasetId: rawInvoices.id,
        versionId: version.versionId,
        createdAt: version.createdAt.toISOString(),
      },
      metadata: { dispatchSource: "lake-reconciliation" },
    })
  })

  test("keeps reconciliation retryable when the dispatcher fails", async () => {
    const descriptor = invoiceProjectionDescriptor()
    const lakeStorage = new InMemoryLakeStorage()
    await commitInvoiceDatasetVersion(lakeStorage)
    const dispatches: ProjectionDispatchInput[] = []
    let attempts = 0
    const dispatcher = createTestProjectionDispatcher(dispatches, async () => {
      attempts += 1
      if (attempts === 1) throw new Error("queue unavailable")
    })
    const reconciler = new ProjectionDispatchReconciler({
      projectId: PROJECT_ID,
      dispatcher,
      descriptors: [descriptor],
      lakeStorage,
      projectionRuns: noProjectionRuns,
    })

    const originalError = console.error
    console.error = () => {}
    try {
      await reconciler.pass()
      await reconciler.pass()
      await reconciler.pass()
    } finally {
      console.error = originalError
    }

    // The failed lookup is retried once; nothing changed after it succeeded.
    expect(attempts).toBe(2)
    expect(dispatches).toHaveLength(1)
  })

  test("reconciles the latest data version behind schema-only versions", async () => {
    const dataVersion: DatasetVersion = {
      datasetId: rawInvoices.id,
      versionId: "data-v1",
      mode: "snapshot",
      createdAt: new Date("2026-04-18T02:00:00.000Z"),
      schema: rawInvoices.schema,
    }
    const schemaVersion: DatasetVersion = {
      datasetId: rawInvoices.id,
      versionId: "schema-v2",
      parentVersionId: dataVersion.versionId,
      mode: "schema",
      createdAt: new Date("2026-04-19T02:00:00.000Z"),
      schema: rawInvoices.schema,
    }
    const dispatches: ProjectionDispatchInput[] = []

    await new ProjectionDispatchReconciler({
      projectId: PROJECT_ID,
      dispatcher: createTestProjectionDispatcher(dispatches),
      descriptors: [invoiceProjectionDescriptor()],
      projectionRuns: noProjectionRuns,
      lakeStorage: {
        listLatestVersionsSince: noLakeChanges,
        async listVersions() {
          return [schemaVersion, dataVersion]
        },
        async getLatestVersion() {
          return schemaVersion
        },
        async getVersion(_datasetId, versionId) {
          return versionId === dataVersion.versionId ? dataVersion : null
        },
      },
    }).pass()

    expect(dispatches[0]?.datasetVersion.versionId).toBe(dataVersion.versionId)
  })

  test("reports malformed projection version ancestry structurally", async () => {
    const descriptor = invoiceProjectionDescriptor()
    const schemaVersion: DatasetVersion = {
      datasetId: rawInvoices.id,
      versionId: "schema-cycle",
      parentVersionId: "schema-cycle",
      mode: "schema",
      createdAt: new Date("2026-04-19T02:00:00.000Z"),
      schema: rawInvoices.schema,
    }
    const errors: unknown[] = []
    const originalError = console.error
    console.error = (_message, error) => {
      errors.push(error)
    }

    try {
      await new ProjectionDispatchReconciler({
        projectId: PROJECT_ID,
        dispatcher: createTestProjectionDispatcher([]),
        descriptors: [descriptor],
        projectionRuns: noProjectionRuns,
        lakeStorage: {
          listLatestVersionsSince: noLakeChanges,
          async listVersions() {
            return [schemaVersion]
          },
          async getLatestVersion() {
            return schemaVersion
          },
          async getVersion() {
            return schemaVersion
          },
        },
      }).pass()
    } finally {
      console.error = originalError
    }

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      message:
        "[SixbOrchestrator] Dataset 'raw.invoices' version ancestry contains a cycle at 'schema-cycle'.",
      details: {
        projectId: PROJECT_ID,
        projectionId: descriptor.projectionId,
        datasetId: rawInvoices.id,
        versionId: schemaVersion.versionId,
      },
    })
  })

  test("direct fan-out retries failed siblings without duplicating admitted jobs", async () => {
    const daily = defineSchedule("daily-fanout").cron("0 2 * * *")
    const sync = defineSync("sync-fails")
      .when(daily)
      .from(connector)
      .read(() => [])
      .intoDataset(rawInvoices)
    const pipeline = definePipeline("pipeline-succeeds")
      .when(daily)
      .then(
        definePipelineStep("pass-through")
          .inputs({ invoices: rawInvoices })
          .output(cleanInvoices)
          .run(() => {})
      )
    const routes = compileRoutes({
      schedules: [daily],
      syncs: [sync],
      pipelines: [pipeline],
    })
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    const enqueueSync = queues.syncRuns.enqueue.bind(queues.syncRuns)
    let syncAttempts = 0
    queues.syncRuns.enqueue = async (params) => {
      if (++syncAttempts === 1) throw new Error("Unavailable")
      return enqueueSync(params)
    }
    const enqueuePipeline = queues.pipelines.enqueue.bind(queues.pipelines)
    let pipelineDispatches = 0
    queues.pipelines.enqueue = async (params) => {
      const jobs = await enqueuePipeline(params)
      pipelineDispatches += 1
      return jobs
    }

    jest.useFakeTimers()
    try {
      await quietly(async () => {
        await startWorker(eventRuntime, queues, routes)
        await eventRuntime.append({ events: [makeScheduleTriggeredEvent(daily.id)] })
        // The batch failed on its sync sibling and waits out a retry backoff.
        await waitFor(() => pipelineDispatches === 1 && jest.getTimerCount() === 1)
        jest.runOnlyPendingTimers()
        await waitFor(() => pipelineDispatches === 2)
      })

      // Claimed on the faked clock: the retried job is stamped with it.
      expect(syncAttempts).toBe(2)
      expect(
        await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "sync", limit: 10 })
      ).toHaveLength(1)
      expect(
        await queues.pipelines.claim({ projectId: PROJECT_ID, workerId: "pipeline", limit: 10 })
      ).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test("stop drains pending direct dispatches", async () => {
    const daily = defineSchedule("daily-stop").cron("0 2 * * *")
    const sync = defineSync("sync-stop")
      .when(daily)
      .from(connector)
      .read(() => [])
      .intoDataset(rawInvoices)
    const routes = compileRoutes({ schedules: [daily], syncs: [sync], pipelines: [] })
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    const worker = await startWorker(eventRuntime, queues, routes)

    await eventRuntime.append({ events: [makeScheduleTriggeredEvent(daily.id)] })
    await worker.stop()

    expect(
      await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "observer" })
    ).toHaveLength(1)
  })

  const invoiceProjectionRoutes = (...descriptors: ProjectionDispatchDescriptor[]) =>
    compileRoutes({ schedules: [], syncs: [], pipelines: [], projections: descriptors })

  test.each([
    {
      name: "an empty project id",
      projectId: "",
      routes: new Map() as OrchestratorRoutes,
      error: { message: "[SixbOrchestrator] projectId is required." },
    },
    {
      name: "projection routes without durable reconciliation",
      projectId: PROJECT_ID,
      routes: invoiceProjectionRoutes(invoiceProjectionDescriptor()),
      error: {
        message:
          "[SixbOrchestrator] Projection routes require lake storage for durable reconciliation.",
        details: { projectId: PROJECT_ID, projectionIds: ["invoice-projection"] },
      },
    },
    {
      name: "conflicting projection routes",
      projectId: PROJECT_ID,
      routes: invoiceProjectionRoutes(
        invoiceProjectionDescriptor(),
        invoiceProjectionDescriptor({ projectionRevision: "projection-2" })
      ),
      error: {
        message:
          "[SixbOrchestrator] Projection 'invoice-projection' has conflicting dispatch routes.",
        details: { projectId: PROJECT_ID, projectionId: "invoice-projection" },
      },
    },
    {
      name: "workflow routes without durable Core dispatch",
      projectId: PROJECT_ID,
      routes: eventWorkflowRoutes(),
      error: {
        message: "[SixbOrchestrator] Routes require the 'workflows' dispatcher.",
        details: { projectId: PROJECT_ID, dispatcher: "workflows" },
      },
    },
  ])("rejects $name structurally", ({ projectId, routes, error }) => {
    expect(
      thrownBy(
        () =>
          new OrchestratorWorker({
            projectId,
            events: createEvents(),
            queues: new InMemoryQueues(),
            routes,
            dispatchers: {},
          })
      )
    ).toMatchObject({ code: "internal.unexpected", retryable: false, ...error })
  })
})
