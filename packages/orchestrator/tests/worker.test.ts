import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
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
  type SixbErrorContext,
  SixbHost,
} from "@sixb/core"
import { attachSixbErrorReporter, flushSixbErrors } from "@sixb/core/internal/error-reporting"
import {
  DomainEventService,
  type EventDraft,
  type StableEventEnvelope,
} from "@sixb/core/internal/events"
import type { ProjectionDispatchDescriptor } from "@sixb/core/internal/projections"
import { WorkflowRunDispatcher } from "@sixb/core/internal/workflows"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { compileRoutes } from "../src/compile-routes"
import { LakeChangeFeed, type LakeChangeFeedInput } from "../src/lake-change-feed"
import { ProjectionDispatchReconciler } from "../src/projection-dispatch-reconciler"
import { createReconciliationPasses } from "../src/reconciliation-passes"
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

// A fake-timer test that times out never reaches its own cleanup; keep it from leaking.
afterEach(() => {
  jest.useRealTimers()
})

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

function makeDatasetVersionCommittedEvent(
  versionId = "v-1",
  changed = { rowsChanged: true, lineageChanged: true }
): EventDraft {
  return {
    type: "dataset.version.committed",
    payload: {
      datasetId: rawInvoices.id,
      versionId,
      createdAt: "2026-04-18T02:00:00.000Z",
      producer: { kind: "sync", id: "source-sync", runId: "run-1" },
      ...changed,
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

/**
 * Fires the one pending fake timer at its delay, and shows it was not due sooner. Asserted here,
 * not left to the next `waitFor`: fake timers stop `Date.now()`, so that one never times out.
 */
function fireTimerDueIn(delayMs: number): void {
  jest.advanceTimersByTime(delayMs - 1)
  expect(jest.getTimerCount()).toBe(1)
  jest.advanceTimersByTime(1)
  expect(jest.getTimerCount()).toBe(0)
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

const signal = new AbortController().signal

const workers: OrchestratorWorker[] = []

// Revert the returned processing promise in consumeBatches: all retained batches enter at once.
// Drop `from: "earliest"` from consumeRetainedEventSchedules: the events published before start are
// never delivered. Skip the retry in JobDispatch: the job that failed is never queued.
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
      // The failed job left the line: every other event is queued while it waits out its 250ms.
      await waitFor(() => acknowledged === 149)
      expect(deliveries).toBe(2)
      await waitFor(() => jest.getTimerCount() === 1)
      fireTimerDueIn(250)
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
  projectionDispatcher?: ProjectionDispatcherPort,
  workflowDispatcher = createTestWorkflowRunDispatcher(queues, undefined, projectId),
  reporter: object = {}
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
      ...(projectionDispatcher === undefined ? {} : { projections: projectionDispatcher }),
    },
    reporter,
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

function testFeed(lakeStorage: LakeChangeFeedInput["lakeStorage"]): LakeChangeFeed {
  return new LakeChangeFeed({ lakeStorage, projectId: PROJECT_ID, freshForMs: 0 })
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
    // Jobs go out one at a time, so they land across polls, and claiming takes them off the queue.
    const claimed: { job: { payload: { runId: string } } }[] = []
    await waitFor(async () => {
      claimed.push(
        ...(await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "sync" })),
        ...(await queues.pipelines.claim({ projectId: PROJECT_ID, workerId: "pipeline" })),
        ...(await queues.workflows.claim({ projectId: PROJECT_ID, workerId: "workflow" }))
      )
      return claimed.length === 3
    })

    for (const { job } of claimed) {
      expect(job.payload.runId).toContain(`event:${sourceEvent!.id}`)
    }
  })

  test("dataset schedules skip versions that change neither rows nor lineage", async () => {
    // Red check: make `matchesDatasetChange` in core's selector predicate return true.
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
      projections: [invoiceProjectionDescriptor()],
    })
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    const projectionDispatches: ProjectionDispatchInput[] = []
    await startWorker(
      eventRuntime,
      queues,
      routes,
      PROJECT_ID,
      createTestProjectionDispatcher(projectionDispatches)
    )

    // One ordered subscription: the jobs of the later versions show the first one was judged.
    const [, lineageOnly, rowsOnly] = await eventRuntime.append({
      events: [
        makeDatasetVersionCommittedEvent("v-1", { rowsChanged: false, lineageChanged: false }),
        makeDatasetVersionCommittedEvent("v-2", { rowsChanged: false, lineageChanged: true }),
        makeDatasetVersionCommittedEvent("v-3", { rowsChanged: true, lineageChanged: false }),
      ],
    })

    const claimed = { sync: [] as string[], pipeline: [] as string[], workflow: [] as string[] }
    const claim = { projectId: PROJECT_ID, workerId: "test", limit: 10 }
    await waitFor(async () => {
      for (const job of await queues.syncRuns.claim(claim)) claimed.sync.push(job.job.payload.runId)
      for (const job of await queues.pipelines.claim(claim)) {
        claimed.pipeline.push(job.job.payload.runId)
      }
      for (const job of await queues.workflows.claim(claim)) {
        claimed.workflow.push(job.job.payload.runId)
      }

      return Object.values(claimed).every((runIds) => runIds.length >= 2)
    })

    for (const runIds of Object.values(claimed)) {
      expect(runIds).toEqual([
        expect.stringContaining(`event:${lineageOnly!.id}`),
        expect.stringContaining(`event:${rowsOnly!.id}`),
      ])
    }

    // Projections apply every version: their markings follow the version they applied.
    await waitFor(() => projectionDispatches.length === 3)
    expect(projectionDispatches.map((dispatch) => dispatch.datasetVersion.versionId)).toEqual([
      "v-1",
      "v-2",
      "v-3",
    ])
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

  test("a member's first sign-in starts a workflow with input mapped from the event", async () => {
    const memberJoined = defineSchedule("member-joined").on(events.users().joined())
    const welcome = defineWorkflow("welcome-member")
      .input({ userId: "string", email: "string" })
      .when(memberJoined, ({ event }) => ({ userId: event.user.id, email: event.user.email }))
      .then(
        defineWorkflowStep("greet")
          .input({ userId: "string", email: "string" })
          .output({})
          .run(() => ({}))
      )
    const routes = compileRoutes({
      schedules: [memberJoined],
      syncs: [],
      pipelines: [],
      workflows: [welcome],
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

    const user = { id: "usr_ava", email: "ava@acme.com", status: "active" } as const
    await eventRuntime.append({
      events: [
        {
          type: "user.suspended",
          payload: { user, requestedBy: { type: "user", id: "usr_admin" } },
        },
      ],
    })
    const [joined] = await eventRuntime.append({
      events: [{ type: "user.joined", payload: { user } }],
    })

    await waitFor(() => dispatches.length === 1)
    expect(dispatches[0]).toMatchObject({
      workflowId: welcome.id,
      input: { userId: "usr_ava", email: "ava@acme.com" },
      scheduleId: memberJoined.id,
      source: { type: "event", eventId: joined!.id },
    })
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
    await startWorker(
      eventRuntime,
      queues,
      routes,
      PROJECT_ID,
      createTestProjectionDispatcher(dispatches)
    )

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
    const lakeStorage = new InMemoryLakeStorage()
    const version = await commitInvoiceDatasetVersion(lakeStorage)
    const dispatches: ProjectionDispatchInput[] = []

    await new ProjectionDispatchReconciler({
      projectId: PROJECT_ID,
      feed: testFeed(lakeStorage),
      dispatcher: createTestProjectionDispatcher(dispatches),
      descriptors: [invoiceProjectionDescriptor()],
      lakeStorage,
      projectionRuns: noProjectionRuns,
    }).pass(signal)

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
      feed: testFeed(lakeStorage),
      dispatcher,
      descriptors: [descriptor],
      lakeStorage,
      projectionRuns: noProjectionRuns,
    })

    const failure = await reconciler.pass(signal).catch((error) => error)
    expect(failure).toBeInstanceOf(AggregateError)

    await reconciler.pass(signal)
    await reconciler.pass(signal)

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
      rowsChanged: true,
      lineageChanged: true,
    }
    const schemaVersion: DatasetVersion = {
      datasetId: rawInvoices.id,
      versionId: "schema-v2",
      parentVersionId: dataVersion.versionId,
      mode: "schema",
      createdAt: new Date("2026-04-19T02:00:00.000Z"),
      schema: rawInvoices.schema,
      rowsChanged: true,
      lineageChanged: true,
    }
    const dispatches: ProjectionDispatchInput[] = []

    await new ProjectionDispatchReconciler({
      projectId: PROJECT_ID,
      dispatcher: createTestProjectionDispatcher(dispatches),
      descriptors: [invoiceProjectionDescriptor()],
      projectionRuns: noProjectionRuns,
      feed: testFeed({ listLatestVersionsSince: noLakeChanges }),
      lakeStorage: {
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
    }).pass(signal)

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
      rowsChanged: true,
      lineageChanged: true,
    }
    const failure = await new ProjectionDispatchReconciler({
      projectId: PROJECT_ID,
      dispatcher: createTestProjectionDispatcher([]),
      descriptors: [descriptor],
      projectionRuns: noProjectionRuns,
      feed: testFeed({ listLatestVersionsSince: noLakeChanges }),
      lakeStorage: {
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
    })
      .pass(signal)
      .catch((error) => error)

    expect(failure.errors).toHaveLength(1)
    expect(failure.errors[0].cause).toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      message:
        "[SixbOrchestrator] Dataset 'raw.invoices' version ancestry contains a cycle at 'schema-cycle'.",
      details: {
        projectId: PROJECT_ID,
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
        // Only the sync sibling failed, and only it waits out a 250ms retry backoff.
        await waitFor(() => pipelineDispatches === 1 && jest.getTimerCount() === 1)
        fireTimerDueIn(250)
        await waitFor(() => syncAttempts === 2)
      })

      // Claimed on the faked clock: the retried job is stamped with it.
      expect(pipelineDispatches).toBe(1)
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

  // Reproduce: await `retry` in `JobDispatch.one`; the pipeline waits for every retry of the sync,
  // and the test's frozen clock never lets them end.
  test("a job that keeps failing holds no other route", async () => {
    const broken = defineSchedule("broken-route").cron("0 2 * * *")
    const healthy = defineSchedule("healthy-route").cron("0 3 * * *")
    const sync = defineSync("sync-always-fails")
      .when(broken)
      .from(connector)
      .read(() => [])
      .intoDataset(rawInvoices)
    const pipeline = definePipeline("pipeline-keeps-running")
      .when(healthy)
      .then(
        definePipelineStep("pass-through")
          .inputs({ invoices: rawInvoices })
          .output(cleanInvoices)
          .run(() => {})
      )
    const routes = compileRoutes({
      schedules: [broken, healthy],
      syncs: [sync],
      pipelines: [pipeline],
    })
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    queues.syncRuns.enqueue = async () => {
      throw new Error("Unavailable")
    }

    jest.useFakeTimers()
    try {
      await quietly(async () => {
        await startWorker(eventRuntime, queues, routes)
        await eventRuntime.append({ events: [makeScheduleTriggeredEvent(broken.id)] })
        await eventRuntime.append({ events: [makeScheduleTriggeredEvent(healthy.id)] })

        await waitFor(async () => {
          const jobs = await queues.pipelines.claim({ projectId: PROJECT_ID, workerId: "test" })
          return jobs.length === 1
        })
      })
    } finally {
      jest.useRealTimers()
    }
  })

  // Reproduce: subscribe once to every direct type in `run`; the retries fill the line and the cron
  // event behind them is never read.
  test("failing projections leave cron routes alone", async () => {
    const daily = defineSchedule("daily-beside-projections").cron("0 2 * * *")
    const sync = defineSync("sync-beside-projections")
      .when(daily)
      .from(connector)
      .read(() => [])
      .intoDataset(rawInvoices)
    const routes = compileRoutes({
      schedules: [daily],
      syncs: [sync],
      pipelines: [],
      projections: [invoiceProjectionDescriptor()],
    })
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    const failingProjections = createTestProjectionDispatcher([], async () => {
      throw new Error("Unavailable")
    })

    jest.useFakeTimers()
    try {
      await quietly(async () => {
        await startWorker(eventRuntime, queues, routes, PROJECT_ID, failingProjections)
        await eventRuntime.append({
          events: Array.from({ length: 80 }, (_, index) =>
            makeDatasetVersionCommittedEvent(`v-${index}`)
          ),
        })
        await waitForTurns(20)
        await eventRuntime.append({ events: [makeScheduleTriggeredEvent(daily.id)] })

        await waitFor(async () => {
          const jobs = await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "test" })
          return jobs.length === 1
        })
      })
    } finally {
      jest.useRealTimers()
    }
  })

  // Reproduce: return the mapper's call in `enqueueEventScheduleTarget` unwrapped; its TypeError
  // reads as an outage and the job retries forever.
  test("a mapper that throws loses that event alone, reported at once", async () => {
    const reported: SixbErrorContext[] = []
    const reporter = {}
    attachSixbErrorReporter(reporter, (_error, context) => {
      reported.push(context)
    })
    const updated = defineSchedule("invoice.updated.mapped").on(events.object(Invoice).updated())
    const mapped = defineWorkflow("mapped-workflow")
      .input({ invoiceId: "string" })
      .when(updated, ({ event }) => {
        if (event.object.primaryId === "inv-1") throw new TypeError("cannot read this one")
        return { invoiceId: event.object.primaryId }
      })
      .then(
        defineWorkflowStep("takes-invoice")
          .input({ invoiceId: "string" })
          .output({})
          .run(() => ({}))
      )
    const routes = compileRoutes({
      schedules: [updated],
      syncs: [],
      pipelines: [],
      workflows: [mapped],
    })
    const queues = new InMemoryQueues()
    const eventRuntime = createEvents()

    await startWorker(eventRuntime, queues, routes, PROJECT_ID, undefined, undefined, reporter)
    await eventRuntime.publishEnvelopes([
      makeInvoiceUpdatedEvent(0, 700),
      {
        ...makeInvoiceUpdatedEvent(0, 800),
        payload: { ...makeInvoiceUpdatedEvent(0, 800).payload, primaryId: "inv-2" },
      } as StableEventEnvelope,
    ])

    await waitFor(async () => {
      const jobs = await queues.workflows.claim({ projectId: PROJECT_ID, workerId: "test" })
      return jobs.length === 1
    })
    await flushSixbErrors(reporter)

    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({
      type: "orchestrator.dispatch.failed",
      target: `workflow:${mapped.id}`,
      attempts: 1,
      dropped: true,
    })
  })

  // Reproduce: drop `directJobStart` from `consumeLiveJobs`; the occurrence emitted before this
  // start is not read, as a job in retry at the last shutdown would not be.
  test("a restart reads cron occurrences again, and starts only what was not dispatched", async () => {
    const daily = defineSchedule("daily-restart").cron("0 2 * * *")
    const sync = defineSync("sync-restart")
      .when(daily)
      .from(connector)
      .read(() => [])
      .intoDataset(rawInvoices)
    const routes = compileRoutes({ schedules: [daily], syncs: [sync], pipelines: [] })
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    const [event] = await eventRuntime.append({ events: [makeScheduleTriggeredEvent(daily.id)] })

    await startWorker(eventRuntime, queues, routes)

    await waitFor(async () => {
      const jobs = await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "test" })
      return jobs.length === 1 && jobs[0]!.job.payload.runId.includes(event!.id)
    })
  })

  // Reproduce: pass `{ types: [eventType] }` in `consumeLiveJobs` for every type; the commit from
  // before the start is delivered and dispatched.
  test("a restart leaves past dataset commits to the projections pass", async () => {
    const routes = compileRoutes({
      schedules: [],
      syncs: [],
      pipelines: [],
      projections: [invoiceProjectionDescriptor()],
    })
    const eventRuntime = createEvents()
    const dispatches: ProjectionDispatchInput[] = []
    await eventRuntime.append({ events: [makeDatasetVersionCommittedEvent("before-start")] })

    await startWorker(
      eventRuntime,
      new InMemoryQueues(),
      routes,
      PROJECT_ID,
      createTestProjectionDispatcher(dispatches)
    )
    await eventRuntime.append({ events: [makeDatasetVersionCommittedEvent("after-start")] })

    await waitFor(() => dispatches.length > 0)
    expect(dispatches.map((input) => input.datasetVersion.versionId)).toEqual(["after-start"])
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
            reporter: {},
          })
      )
    ).toMatchObject({ code: "internal.unexpected", retryable: false, ...error })
  })

  test.each([
    {
      name: "projection routes without durable reconciliation",
      routes: invoiceProjectionRoutes(invoiceProjectionDescriptor()),
      error: {
        message:
          "[SixbOrchestrator] Projection routes require lake storage for durable reconciliation.",
        details: { projectId: PROJECT_ID, projectionIds: ["invoice-projection"] },
      },
    },
    {
      name: "conflicting projection routes",
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
  ])("reconciliation rejects $name structurally", ({ routes, error }) => {
    expect(
      thrownBy(() =>
        createReconciliationPasses({
          projectId: PROJECT_ID,
          routes,
          dispatchers: { projections: createTestProjectionDispatcher([]) },
          lakeStorage: new InMemoryLakeStorage(),
        })
      )
    ).toMatchObject({ code: "internal.unexpected", retryable: false, ...error })
  })

  // Reproduce: create a `LakeChangeFeed` per pass in `createReconciliationPasses`; it counts two.
  test("projections and dataset triggers read the lake's feed with one query", async () => {
    const updated = defineSchedule("raw.updated.shared").on(events.dataset(rawInvoices).updated())
    const pipeline = definePipeline("shared-feed-pipeline")
      .when(updated)
      .then(
        definePipelineStep("pass-through")
          .inputs({ invoices: rawInvoices })
          .output(cleanInvoices)
          .run(() => {})
      )
    const lakeStorage = new InMemoryLakeStorage()
    const storage = new InMemoryStorage()
    const passes = createReconciliationPasses({
      projectId: PROJECT_ID,
      routes: compileRoutes({
        schedules: [updated],
        syncs: [],
        pipelines: [pipeline],
        projections: [invoiceProjectionDescriptor()],
      }),
      dispatchers: {
        projections: createTestProjectionDispatcher([]),
        pipelines: createTestPipelineRunDispatcher(new InMemoryQueues()),
      },
      lakeStorage,
      projections: { lakeStorage, projectionRuns: noProjectionRuns },
      datasetTriggers: { lakeStorage, pipelineRuns: storage.pipelineRuns },
    })
    const feed = spyOn(lakeStorage, "listLatestVersionsSince")

    await Promise.all(passes.map((pass) => pass.run(signal)))

    expect(passes.map((pass) => pass.id)).toEqual(["projections", "triggers"])
    expect(feed).toHaveBeenCalledTimes(1)
  })

  test("adds no pass for a project with nothing to reconcile", () => {
    const passes = createReconciliationPasses({
      projectId: PROJECT_ID,
      routes: new Map(),
      dispatchers: {},
      lakeStorage: new InMemoryLakeStorage(),
    })

    expect(passes).toEqual([])
  })
})
