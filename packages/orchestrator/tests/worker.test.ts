import { afterEach, describe, expect, test } from "bun:test"
import {
  col,
  defineConnector,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineSchedule,
  defineSync,
  defineWorkflow,
  defineWorkflowStep,
  events,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  prop,
  SYSTEM_PRINCIPAL,
} from "@sixb/core"
import {
  type EventDraft,
  EventsRuntime,
  type StableEventEnvelope,
} from "@sixb/core/internal/events"
import {
  createProjectionRunId,
  type ProjectionDispatchDescriptor,
} from "@sixb/core/internal/projections"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import { InMemoryProjectionRunStorage } from "@sixb/core/storage"
import { compileRoutes } from "../src/compile-routes"
import { reconcileProjectionDispatch } from "../src/projection-dispatch-reconciler"
import type { OrchestratorRoutes, OrchestratorRuntimeOptions } from "../src/types"
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

function createEvents(projectId = PROJECT_ID, broker = new InMemoryBroker()): EventsRuntime {
  return new EventsRuntime({ projectId, broker })
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

const workers: OrchestratorWorker[] = []

afterEach(async () => {
  for (const worker of workers) await worker.stop().catch(() => {})
  workers.length = 0
})

async function startWorker(
  eventRuntime: EventsRuntime,
  queues: InMemoryQueues,
  routes: OrchestratorRoutes,
  projectId = PROJECT_ID,
  projectionDispatch?: OrchestratorRuntimeOptions["projectionDispatch"]
): Promise<OrchestratorWorker> {
  const worker = new OrchestratorWorker({
    projectId,
    events: eventRuntime,
    queues,
    routes,
    ...(projectionDispatch === undefined ? {} : { projectionDispatch }),
  })
  workers.push(worker)
  await worker.start()
  return worker
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
    await startWorker(eventRuntime, queues, routes)

    const [sourceEvent] = await eventRuntime.append({
      events: [makeScheduleTriggeredEvent(daily.id)],
    })

    await waitFor(async () => {
      const syncJobs = await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "sync" })
      const workflowJobs = await queues.workflows.claim({
        projectId: PROJECT_ID,
        workerId: "workflow",
      })
      if (syncJobs.length === 0 || workflowJobs.length === 0) return false

      expect(syncJobs[0]!.job.payload.runId).toBe(
        `sync:${sync.id}:schedule:${daily.id}:event:${sourceEvent!.id}`
      )
      expect(workflowJobs[0]!.job.payload).toEqual({
        workflowId: workflow.id,
        runId: `workflow:${workflow.id}:schedule:${daily.id}:event:${sourceEvent!.id}`,
        input: {},
        source: {
          type: "schedule",
          scheduleId: daily.id,
          eventId: sourceEvent!.id,
          principal: SYSTEM_PRINCIPAL,
        },
      })
      return true
    })
  })

  test("event schedule fires only on a false-to-true transition and maps { event }", async () => {
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    await startWorker(eventRuntime, queues, eventWorkflowRoutes())

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
        workflowId: highValueInvoiceWorkflow.id,
        runId: `workflow:${highValueInvoiceWorkflow.id}:schedule:${highValueInvoice.id}:event:${sourceEvent!.id}`,
        input: { invoiceId: "inv-1", amount: 700 },
        source: {
          type: "schedule",
          scheduleId: highValueInvoice.id,
          eventId: sourceEvent!.id,
          principal: SYSTEM_PRINCIPAL,
        },
      })
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
    await startWorker(eventRuntime, queues, routes)

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
  })

  test("dataset commits inject the version into direct projection jobs", async () => {
    const projection = defineProjection("invoice-projection", Invoice)
      .fromDataset(rawInvoices)
      .properties({ id: "id" })
    const descriptor = invoiceProjectionDescriptor({ projectionId: projection.id })
    const routes = compileRoutes({
      schedules: [],
      syncs: [],
      pipelines: [],
      projections: [descriptor],
    })
    const eventRuntime = createEvents()
    const queues = new InMemoryQueues()
    await startWorker(eventRuntime, queues, routes, PROJECT_ID, {
      lakeStorage: new InMemoryLakeStorage(),
      projectionRuns: new InMemoryProjectionRunStorage(),
    })

    const [sourceEvent] = await eventRuntime.append({
      events: [makeDatasetVersionCommittedEvent("version-42")],
    })
    await waitFor(async () => {
      const claimed = await queues.projections.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      if (claimed.length === 0) return false
      const expectedPayload = {
        projectionId: projection.id,
        projectionKind: "object" as const,
        protocol: "replacement" as const,
        datasetVersion: {
          datasetId: rawInvoices.id,
          versionId: "version-42",
          createdAt: "2026-04-18T02:00:00.000Z",
        },
        ontologyRevision: "ontology-1",
        projectionRevision: "projection-1",
        ownershipHash: "ownership-1",
      }
      expect(claimed[0]!.job.payload).toEqual(expectedPayload)
      expect(claimed[0]!.job.id).toBe(createProjectionRunId(PROJECT_ID, expectedPayload))
      expect(claimed[0]!.job.metadata).toMatchObject({
        sourceEventId: sourceEvent!.id,
        sourceEventType: "dataset.version.committed",
      })
      return true
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
    const projectionRuns = new InMemoryProjectionRunStorage()
    const queues = new InMemoryQueues()

    await startWorker(createEvents(), queues, routes, PROJECT_ID, {
      lakeStorage,
      projectionRuns,
    })

    await waitFor(async () => {
      const claimed = await queues.projections.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      if (claimed.length === 0) return false
      expect(claimed[0]!.job.payload.datasetVersion).toEqual({
        datasetId: rawInvoices.id,
        versionId: version.versionId,
        createdAt: version.createdAt.toISOString(),
      })
      expect(claimed[0]!.job.metadata).toMatchObject({
        dispatchSource: "lake-reconciliation",
      })
      return true
    })
  })

  test("retries reconciliation and deduplicates the deterministic projection job", async () => {
    const descriptor = invoiceProjectionDescriptor()
    const lakeStorage = new InMemoryLakeStorage()
    await commitInvoiceDatasetVersion(lakeStorage)
    const projectionRuns = new InMemoryProjectionRunStorage()
    const queues = new InMemoryQueues()
    const enqueue = queues.projections.enqueue.bind(queues.projections)
    let attempts = 0
    queues.projections.enqueue = async (input) => {
      attempts += 1
      if (attempts === 1) throw new Error("queue unavailable")
      return enqueue(input)
    }
    const input = {
      projectId: PROJECT_ID,
      queue: queues.projections,
      descriptors: [descriptor],
      lakeStorage,
      projectionRuns,
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
    expect(
      await queues.projections.claim({ projectId: PROJECT_ID, workerId: "observer" })
    ).toHaveLength(1)
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
    const queues = new InMemoryQueues()

    await reconcileProjectionDispatch({
      projectId: PROJECT_ID,
      queue: queues.projections,
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
      projectionRuns: new InMemoryProjectionRunStorage(),
    })

    const [claimed] = await queues.projections.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(claimed?.job.payload.datasetVersion.versionId).toBe(dataVersion.versionId)
  })

  test("skips an existing run and redispatches after a semantic revision change", async () => {
    const descriptor = invoiceProjectionDescriptor()
    const lakeStorage = new InMemoryLakeStorage()
    const version = await commitInvoiceDatasetVersion(lakeStorage)
    const projectionRuns = new InMemoryProjectionRunStorage()
    const queues = new InMemoryQueues()
    const identity = {
      projectionId: descriptor.projectionId,
      projectionKind: "object" as const,
      protocol: "replacement" as const,
      datasetVersion: {
        datasetId: version.datasetId,
        versionId: version.versionId,
        createdAt: version.createdAt.toISOString(),
      },
      ontologyRevision: descriptor.ontologyRevision,
      projectionRevision: descriptor.projectionRevision,
      ownershipHash: descriptor.ownershipHash,
    }
    const id = createProjectionRunId(PROJECT_ID, identity)
    await projectionRuns.startOrReclaim({
      id,
      projectId: PROJECT_ID,
      identity,
      target: { objectTypeId: Invoice.id },
    })

    await reconcileProjectionDispatch({
      projectId: PROJECT_ID,
      queue: queues.projections,
      descriptors: [descriptor],
      lakeStorage,
      projectionRuns,
    })

    expect(
      await queues.projections.claim({ projectId: PROJECT_ID, workerId: "observer" })
    ).toHaveLength(0)

    await reconcileProjectionDispatch({
      projectId: PROJECT_ID,
      queue: queues.projections,
      descriptors: [invoiceProjectionDescriptor({ projectionRevision: "projection-2" })],
      lakeStorage,
      projectionRuns,
    })
    const [revised] = await queues.projections.claim({
      projectId: PROJECT_ID,
      workerId: "revised-observer",
    })
    expect(revised?.job.payload.projectionRevision).toBe("projection-2")
    expect(revised?.job.id).not.toBe(id)
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
      () =>
        new OrchestratorWorker({
          projectId: "",
          events: createEvents(),
          queues: new InMemoryQueues(),
          routes: new Map(),
        })
    ).toThrow("[SixbOrchestrator] projectId is required.")
  })
})
