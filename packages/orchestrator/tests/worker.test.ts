import { afterEach, describe, expect, test } from "bun:test"
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
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  prop,
} from "@sixb/core"
import {
  DomainEventService,
  type EventDraft,
  type StableEventEnvelope,
} from "@sixb/core/internal/events"
import type { ProjectionDispatchDescriptor } from "@sixb/core/internal/projections"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { compileRoutes } from "../src/compile-routes"
import { reconcileProjectionDispatch } from "../src/projection-dispatch-reconciler"
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
    origin: { kind: "runtime", requestId: `request-${amountBefore}-${amountAfter}` },
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

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for condition.")
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
        correlationId: sourceEvent!.id,
      }),
    ])
  })

  test("event schedule fires only on a false-to-true transition and maps { event }", async () => {
    const eventRuntime = createEvents()
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

    await eventRuntime.publishEnvelopes([makeInvoiceUpdatedEvent(600, 700)])
    await Bun.sleep(50)
    expect(
      await queues.workflows.claim({ projectId: PROJECT_ID, workerId: "no-edge" })
    ).toHaveLength(0)

    const [sourceEvent] = await eventRuntime.publishEnvelopes([makeInvoiceUpdatedEvent(400, 700)])

    await waitFor(async () => {
      const claimed = await queues.workflows.claim({ projectId: PROJECT_ID, workerId: "edge" })
      if (claimed.length === 0) return false
      expect(claimed[0]!.job.payload).toEqual({
        runId: `workflow:${highValueInvoiceWorkflow.id}:schedule:${highValueInvoice.id}:event:${sourceEvent!.id}`,
      })
      expect(dispatches).toEqual([
        expect.objectContaining({
          workflowId: highValueInvoiceWorkflow.id,
          input: { invoiceId: "inv-1", amount: 700 },
          scheduleId: highValueInvoice.id,
          source: { type: "event", eventId: sourceEvent!.id },
          correlationId: sourceEvent!.id,
        }),
      ])
      return true
    })
  })

  test("retained event schedules catch up when the orchestrator starts", async () => {
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    const [sourceEvent] = await eventRuntime.publishEnvelopes([makeInvoiceUpdatedEvent(400, 700)])

    await startWorker(eventRuntime, queues, eventWorkflowRoutes())

    await waitFor(async () => {
      const claimed = await queues.workflows.claim({ projectId: PROJECT_ID, workerId: "observer" })
      if (claimed.length === 0) return false
      expect(claimed[0]!.job.payload.runId).toBe(
        `workflow:${highValueInvoiceWorkflow.id}:schedule:${highValueInvoice.id}:event:${sourceEvent!.id}`
      )
      return true
    })
  })

  test("a transient event-schedule enqueue failure is replayed", async () => {
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    await eventRuntime.publishEnvelopes([makeInvoiceUpdatedEvent(400, 700)])

    let enqueueAttempts = 0
    const enqueue = queues.workflows.enqueue.bind(queues.workflows)
    queues.workflows.enqueue = async (params) => {
      enqueueAttempts += 1
      if (enqueueAttempts === 1) throw new Error("Transient enqueue failure")
      return enqueue(params)
    }

    const originalError = console.error
    console.error = () => {}
    try {
      await startWorker(eventRuntime, queues, eventWorkflowRoutes())
      await waitFor(async () => {
        const claimed = await queues.workflows.claim({
          projectId: PROJECT_ID,
          workerId: "observer",
        })
        return claimed.length === 1
      })
      expect(enqueueAttempts).toBe(2)
    } finally {
      console.error = originalError
    }
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
    await Bun.sleep(50)
    expect(
      await queues.workflows.claim({ projectId: PROJECT_ID, workerId: "failed" })
    ).toHaveLength(0)

    await eventRuntime.append({
      correlationId: "upstream-correlation",
      events: [
        {
          type: "sync.run.finished",
          payload: { syncId: upstream.id, runId: "ok-run", status: "succeeded" },
        },
      ],
    })
    await waitFor(async () => {
      const claimed = await queues.workflows.claim({ projectId: PROJECT_ID, workerId: "ok" })
      return claimed.length === 1
    })
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]?.correlationId).toBe("upstream-correlation")
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
      reconciliation: { lakeStorage: new InMemoryLakeStorage() },
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
      reconciliation: { lakeStorage },
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
    const input = {
      projectId: PROJECT_ID,
      dispatcher,
      descriptors: [descriptor],
      lakeStorage,
    }

    const originalError = console.error
    console.error = () => {}
    try {
      await reconcileProjectionDispatch(input)
      await reconcileProjectionDispatch(input)
      await reconcileProjectionDispatch(input)
    } finally {
      console.error = originalError
    }

    expect(attempts).toBe(3)
    expect(dispatches).toHaveLength(2)
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

    await reconcileProjectionDispatch({
      projectId: PROJECT_ID,
      dispatcher: createTestProjectionDispatcher(dispatches),
      descriptors: [invoiceProjectionDescriptor()],
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
    })

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
      await reconcileProjectionDispatch({
        projectId: PROJECT_ID,
        dispatcher: createTestProjectionDispatcher([]),
        descriptors: [descriptor],
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

  test("a direct enqueue failure does not drop fan-out siblings", async () => {
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
    queues.syncRuns.enqueue = async () => {
      throw new Error("Unavailable")
    }

    const originalError = console.error
    console.error = () => {}
    try {
      await startWorker(eventRuntime, queues, routes)
      await eventRuntime.append({ events: [makeScheduleTriggeredEvent(daily.id)] })
      await waitFor(async () => {
        const claimed = await queues.pipelines.claim({
          projectId: PROJECT_ID,
          workerId: "observer",
        })
        return claimed.length === 1
      })
    } finally {
      console.error = originalError
    }
  })

  test("project-scoped subscriptions ignore another project's events", async () => {
    const broker = new InMemoryBroker()
    const eventRuntime = createEvents(PROJECT_ID, broker)
    const otherEvents = createEvents("other-project", broker)
    const queues = new InMemoryQueues()
    await startWorker(eventRuntime, queues, eventWorkflowRoutes())

    await otherEvents.publishEnvelopes([makeInvoiceUpdatedEvent(400, 700, "other-project")])
    await Bun.sleep(50)

    expect(
      await queues.workflows.claim({ projectId: PROJECT_ID, workerId: "observer" })
    ).toHaveLength(0)
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

  test("rejects an empty project id", () => {
    expect(
      thrownBy(
        () =>
          new OrchestratorWorker({
            projectId: "",
            events: createEvents(),
            queues: new InMemoryQueues(),
            routes: new Map(),
            dispatchers: {},
          })
      )
    ).toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      message: "[SixbOrchestrator] projectId is required.",
    })
  })

  test("reports projection dispatch configuration errors structurally", () => {
    const descriptor = invoiceProjectionDescriptor()
    const routes = compileRoutes({
      schedules: [],
      syncs: [],
      pipelines: [],
      projections: [descriptor],
    })

    expect(
      thrownBy(
        () =>
          new OrchestratorWorker({
            projectId: PROJECT_ID,
            events: createEvents(),
            queues: new InMemoryQueues(),
            routes,
            dispatchers: {},
          })
      )
    ).toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      message:
        "[SixbOrchestrator] Projection routes require lake and projection-run storage for durable dispatch.",
      details: {
        projectId: PROJECT_ID,
        projectionIds: [descriptor.projectionId],
      },
    })
  })

  test("reports conflicting projection routes with their correlation details", () => {
    const descriptor = invoiceProjectionDescriptor()
    const routes = compileRoutes({
      schedules: [],
      syncs: [],
      pipelines: [],
      projections: [
        descriptor,
        invoiceProjectionDescriptor({ projectionRevision: "projection-2" }),
      ],
    })

    expect(
      thrownBy(
        () =>
          new OrchestratorWorker({
            projectId: PROJECT_ID,
            events: createEvents(),
            queues: new InMemoryQueues(),
            routes,
            dispatchers: {},
          })
      )
    ).toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      message: `[SixbOrchestrator] Projection '${descriptor.projectionId}' has conflicting dispatch routes.`,
      details: { projectId: PROJECT_ID, projectionId: descriptor.projectionId },
    })
  })

  test("requires durable Core dispatch for workflow routes", () => {
    expect(
      () =>
        new OrchestratorWorker({
          projectId: PROJECT_ID,
          events: createEvents(),
          queues: new InMemoryQueues(),
          routes: eventWorkflowRoutes(),
          dispatchers: {},
        })
    ).toThrow("[SixbOrchestrator] Routes require the 'workflows' dispatcher.")
  })
})
