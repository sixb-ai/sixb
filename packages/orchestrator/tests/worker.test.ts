import { afterEach, describe, expect, test } from "bun:test"
import {
  type DomainEvent,
  defineObjectType,
  defineTrigger,
  defineWorkflow,
  defineWorkflowStep,
  type EventDraft,
  EventsRuntime,
  events as eventSelectors,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  Sixb,
  SYSTEM_PRINCIPAL,
} from "@sixb/core"
import type { OrchestratorJob, OrchestratorRouteKey, OrchestratorRoutes } from "../src/types"
import { OrchestratorWorker } from "../src/worker"

const PROJECT_ID = "test-project"

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true }), prop("amount", "double")],
})

const highValueInvoice = defineTrigger("invoice.high-value")
  .on(eventSelectors(Invoice).updated())
  .where((event) => event.object.p.amount.gt(500))

const captureInvoice = defineWorkflowStep("capture-invoice")
  .input({ invoiceId: "string", amount: "double" })
  .output({})
  .run(() => ({}))

const highValueInvoiceWorkflow = defineWorkflow("notify-high-value-invoice")
  .input({ invoiceId: "string", amount: "double" })
  .when(highValueInvoice, (event) => ({
    invoiceId: event.object.primaryId,
    amount: event.object.p.amount,
  }))
  .then(captureInvoice)

function createEvents(projectId = PROJECT_ID, broker = new InMemoryBroker()): EventsRuntime {
  return new EventsRuntime({ projectId, broker })
}

function createSixbForTriggerWorkflow() {
  const broker = new InMemoryBroker()
  return new Sixb({
    id: PROJECT_ID,
    ontology: [Invoice],
    actions: [],
    functions: [],
    workflows: [highValueInvoiceWorkflow],
    triggers: [highValueInvoice],
    broker,
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
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

function makeObjectUpsertedEvent(): EventDraft {
  return {
    type: "object.upserted",
    payload: {
      objectTypeId: "Room",
      primaryId: "room-1",
      properties: { name: "Room A" },
    },
  }
}

function makeInvoiceUpdatedEvent(amountBefore: number, amountAfter: number): EventDraft {
  return {
    type: "object.updated",
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

function makeDatasetVersionCommittedEvent(datasetId: string, versionId = "v-1"): EventDraft {
  return {
    type: "dataset.version.committed",
    payload: {
      datasetId,
      versionId,
      producer: { kind: "sync", id: "sync-orders", runId: "run-1" },
    },
  }
}

function buildRoutes(entries: [OrchestratorRouteKey, OrchestratorJob[]][]): OrchestratorRoutes {
  return new Map(
    entries.map(([key, jobs]) => [
      key,
      { eventType: key.split(":")[0] as DomainEvent["type"], jobs },
    ])
  )
}

function triggerWorkflowRoutes(): OrchestratorRoutes {
  return new Map([
    [
      "trigger:object.updated:Invoice",
      {
        eventType: "object.updated",
        jobs: [],
        workflowTriggers: [
          {
            workflowId: highValueInvoiceWorkflow.id,
            triggerId: highValueInvoice.id,
          },
        ],
      },
    ],
  ])
}

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for condition.")
}

// Track workers for cleanup
const workers: OrchestratorWorker[] = []

afterEach(async () => {
  for (const worker of workers) {
    await worker.stop().catch(() => {})
  }
  workers.length = 0
})

async function startWorker(
  events: EventsRuntime,
  queues: InMemoryQueues,
  routes: OrchestratorRoutes,
  projectId = PROJECT_ID
): Promise<OrchestratorWorker> {
  const worker = new OrchestratorWorker({ projectId, events, queues, routes })
  workers.push(worker)
  await worker.start()
  return worker
}

describe("OrchestratorWorker", () => {
  test("happy path: schedule.triggered enqueues a syncRuns job", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-orders" } },
          },
        ],
      ],
    ])

    await startWorker(events, queues, routes)

    await events.append({
      events: [makeScheduleTriggeredEvent("daily")],
    })

    await waitFor(async () => {
      const claimed = await queues.syncRuns.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      return claimed.length === 1
    })
  })

  test("schedule.triggered enqueues a workflow job", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "workflows",
            job: {
              type: "workflow.run.requested",
              payload: { workflowId: "nightly-reconciliation", input: {} },
            },
          },
        ],
      ],
    ])

    await startWorker(events, queues, routes)

    await events.append({
      events: [makeScheduleTriggeredEvent("daily")],
    })

    await waitFor(async () => {
      const claimed = await queues.workflows.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      if (claimed.length === 0) return false

      expect(claimed[0]!.job.payload).toEqual({
        workflowId: "nightly-reconciliation",
        input: {},
      })
      return true
    })
  })

  test("trigger workflow route enqueues a workflow job", async () => {
    const sixb = createSixbForTriggerWorkflow()
    const routes = triggerWorkflowRoutes()

    const worker = new OrchestratorWorker({
      projectId: PROJECT_ID,
      events: sixb.events,
      queues: sixb.queues,
      routes,
      workflows: [highValueInvoiceWorkflow],
      triggers: [highValueInvoice],
    })
    workers.push(worker)
    await worker.start()

    const [event] = await sixb.events.append({
      events: [makeInvoiceUpdatedEvent(400, 700)],
    })
    expect(event).toBeDefined()

    const runId = `workflow:${highValueInvoiceWorkflow.id}:trigger:${highValueInvoice.id}:event:${event!.id}`

    await waitFor(async () => {
      const claimed = await sixb.queues.workflows.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      if (claimed.length === 0) return false

      expect(claimed[0]!.job.payload).toEqual({
        workflowId: highValueInvoiceWorkflow.id,
        runId,
        input: { invoiceId: "inv-1", amount: 700 },
        source: {
          type: "trigger",
          triggerId: highValueInvoice.id,
          eventId: event!.id,
          principal: SYSTEM_PRINCIPAL,
        },
      })
      return true
    })
  })

  test("replays retained trigger events when the orchestrator starts", async () => {
    const sixb = createSixbForTriggerWorkflow()
    const [event] = await sixb.events.append({
      events: [makeInvoiceUpdatedEvent(400, 700)],
    })

    const worker = new OrchestratorWorker({
      projectId: PROJECT_ID,
      events: sixb.events,
      queues: sixb.queues,
      routes: triggerWorkflowRoutes(),
      workflows: [highValueInvoiceWorkflow],
      triggers: [highValueInvoice],
    })
    workers.push(worker)
    await worker.start()

    await waitFor(async () => {
      const claimed = await sixb.queues.workflows.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      if (claimed.length === 0) return false
      expect(claimed[0]!.job.payload.runId).toBe(
        `workflow:${highValueInvoiceWorkflow.id}:trigger:${highValueInvoice.id}:event:${event!.id}`
      )
      return true
    })
  })

  test("replays a retained trigger after a transient workflow enqueue failure", async () => {
    const sixb = createSixbForTriggerWorkflow()
    await sixb.events.append({
      events: [makeInvoiceUpdatedEvent(400, 700)],
    })

    let enqueueAttempts = 0
    const enqueue = sixb.queues.workflows.enqueue.bind(sixb.queues.workflows)
    sixb.queues.workflows.enqueue = async (params) => {
      enqueueAttempts += 1
      if (enqueueAttempts === 1) {
        throw new Error("Transient workflow enqueue failure")
      }
      return enqueue(params)
    }

    const originalError = console.error
    console.error = () => {}
    try {
      const worker = new OrchestratorWorker({
        projectId: PROJECT_ID,
        events: sixb.events,
        queues: sixb.queues,
        routes: triggerWorkflowRoutes(),
        workflows: [highValueInvoiceWorkflow],
        triggers: [highValueInvoice],
      })
      workers.push(worker)
      await worker.start()

      await waitFor(async () => {
        const claimed = await sixb.queues.workflows.claim({
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

  test("fan-out: same event triggers jobs on both lanes", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-a" } },
          },
          {
            queue: "pipelines",
            job: { type: "pipeline.run.requested", payload: { pipelineId: "pipe-b" } },
          },
          {
            queue: "pipelines",
            job: { type: "pipeline.run.requested", payload: { pipelineId: "pipe-c" } },
          },
        ],
      ],
    ])

    const worker = new OrchestratorWorker({
      projectId: PROJECT_ID,
      events,
      queues,
      routes,
    })
    workers.push(worker)
    await worker.start()

    await events.append({
      events: [makeScheduleTriggeredEvent("daily")],
    })

    // stop() drains pending dispatches, so all jobs are guaranteed to be enqueued
    await worker.stop()

    const syncJobs = await queues.syncRuns.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    const pipelineJobs = await queues.pipelines.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
      limit: 10,
    })
    expect(syncJobs).toHaveLength(1)
    expect(pipelineJobs).toHaveLength(2)
  })

  test("fan-out: same schedule can route to sync, pipeline, and workflow lanes", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-a" } },
          },
          {
            queue: "pipelines",
            job: { type: "pipeline.run.requested", payload: { pipelineId: "pipe-b" } },
          },
          {
            queue: "workflows",
            job: {
              type: "workflow.run.requested",
              payload: { workflowId: "workflow-c", input: {} },
            },
          },
        ],
      ],
    ])

    const worker = new OrchestratorWorker({
      projectId: PROJECT_ID,
      events,
      queues,
      routes,
    })
    workers.push(worker)
    await worker.start()

    await events.append({
      events: [makeScheduleTriggeredEvent("daily")],
    })

    await worker.stop()

    const syncJobs = await queues.syncRuns.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    const pipelineJobs = await queues.pipelines.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    const workflowJobs = await queues.workflows.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })

    expect(syncJobs).toHaveLength(1)
    expect(pipelineJobs).toHaveLength(1)
    expect(workflowJobs).toHaveLength(1)
    expect(workflowJobs[0]!.job.payload.workflowId).toBe("workflow-c")
  })

  test("filtering: non-routed event type produces no jobs", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-a" } },
          },
        ],
      ],
    ])

    await startWorker(events, queues, routes)

    // Append an object.upserted event — should be ignored by subscription filter
    await events.append({
      events: [makeObjectUpsertedEvent()],
    })

    // Small delay to let any potential dispatch settle
    await Bun.sleep(50)

    const claimed = await queues.syncRuns.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })

  test("filtering: schedule.triggered for unknown schedule produces no jobs", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-a" } },
          },
        ],
      ],
    ])

    await startWorker(events, queues, routes)

    // Append a schedule.triggered for an unregistered schedule
    await events.append({
      events: [makeScheduleTriggeredEvent("unknown-schedule")],
    })

    await Bun.sleep(50)

    const claimed = await queues.syncRuns.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })

  test("filtering: unrelated schedule produces no workflow job", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "workflows",
            job: {
              type: "workflow.run.requested",
              payload: { workflowId: "nightly-reconciliation", input: {} },
            },
          },
        ],
      ],
    ])

    await startWorker(events, queues, routes)

    await events.append({
      events: [makeScheduleTriggeredEvent("unknown-schedule")],
    })

    await Bun.sleep(50)

    const claimed = await queues.workflows.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })

  test("metadata: enqueued job carries sourceEventId, sourceEventType, scheduleId, occurrenceKey", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-orders" } },
          },
        ],
      ],
    ])

    await startWorker(events, queues, routes)

    const [stored] = await events.append({
      events: [makeScheduleTriggeredEvent("daily", "2026-04-18T02:00:00.000Z")],
    })

    await waitFor(async () => {
      const claimed = await queues.syncRuns.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      if (claimed.length === 0) return false

      const meta = claimed[0]!.job.metadata
      expect(meta).toBeDefined()
      expect(meta!.sourceEventId).toBe(stored!.id)
      expect(meta!.sourceEventType).toBe("schedule.triggered")
      expect(meta!.scheduleId).toBe("daily")
      expect(meta!.occurrenceKey).toBe("daily:2026-04-18T02:00:00.000Z")
      return true
    })
  })

  test("metadata: workflow job carries source event metadata", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "workflows",
            job: {
              type: "workflow.run.requested",
              payload: { workflowId: "nightly-reconciliation", input: {} },
            },
          },
        ],
      ],
    ])

    await startWorker(events, queues, routes)

    const [stored] = await events.append({
      events: [makeScheduleTriggeredEvent("daily", "2026-04-18T02:00:00.000Z")],
    })

    await waitFor(async () => {
      const claimed = await queues.workflows.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      if (claimed.length === 0) return false

      expect(claimed[0]!.job.metadata).toMatchObject({
        sourceEventId: stored!.id,
        sourceEventType: "schedule.triggered",
        scheduleId: "daily",
        occurrenceKey: "daily:2026-04-18T02:00:00.000Z",
      })
      return true
    })
  })

  test("order: 3 events appended in one batch produce 3 jobs in order", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:s1",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-1" } },
          },
        ],
      ],
      [
        "schedule.triggered:s2",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-2" } },
          },
        ],
      ],
      [
        "schedule.triggered:s3",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-3" } },
          },
        ],
      ],
    ])

    const worker = new OrchestratorWorker({
      projectId: PROJECT_ID,
      events,
      queues,
      routes,
    })
    workers.push(worker)
    await worker.start()

    await events.append({
      events: [
        makeScheduleTriggeredEvent("s1"),
        makeScheduleTriggeredEvent("s2"),
        makeScheduleTriggeredEvent("s3"),
      ],
    })

    // stop() drains all pending dispatches
    await worker.stop()

    const claimed = await queues.syncRuns.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
      limit: 10,
    })
    expect(claimed).toHaveLength(3)
    expect(claimed[0]!.job.payload.syncId).toBe("sync-1")
    expect(claimed[1]!.job.payload.syncId).toBe("sync-2")
    expect(claimed[2]!.job.payload.syncId).toBe("sync-3")
  })

  test("stop() drains pending dispatches before resolving", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-orders" } },
          },
        ],
      ],
    ])

    const worker = new OrchestratorWorker({
      projectId: PROJECT_ID,
      events,
      queues,
      routes,
    })
    workers.push(worker)
    await worker.start()

    await events.append({
      events: [makeScheduleTriggeredEvent("daily")],
    })

    // Stop immediately — should still drain the pending dispatch
    await worker.stop()

    const claimed = await queues.syncRuns.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(1)
  })

  test("robustness: enqueue failure on one job does not drop sibling jobs", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const originalError = console.error
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    // Monkey-patch syncRuns.enqueue to fail once
    let callCount = 0
    const originalEnqueue = queues.syncRuns.enqueue.bind(queues.syncRuns)
    queues.syncRuns.enqueue = async (params) => {
      callCount++
      if (callCount === 1) {
        throw new Error("Transient enqueue failure")
      }
      return originalEnqueue(params)
    }

    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-will-fail" } },
          },
          {
            queue: "pipelines",
            job: { type: "pipeline.run.requested", payload: { pipelineId: "pipe-should-succeed" } },
          },
        ],
      ],
    ])

    try {
      await startWorker(events, queues, routes)

      await events.append({
        events: [makeScheduleTriggeredEvent("daily")],
      })

      // The pipeline job should still have been enqueued despite the sync failure
      await waitFor(async () => {
        const claimed = await queues.pipelines.claim({
          projectId: PROJECT_ID,
          workerId: "observer",
        })
        return claimed.length === 1
      })

      // The sync lane should have no jobs (the enqueue failed)
      const syncClaimed = await queues.syncRuns.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      expect(syncClaimed).toHaveLength(0)
      expect(String(errors[0]?.[0])).toContain("[SixbOrchestrator] Enqueue failed")
      expect(errors[0]?.[1]).toBeInstanceOf(Error)
    } finally {
      console.error = originalError
    }
  })

  test("robustness: workflow enqueue failure does not drop sibling jobs", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()

    let callCount = 0
    const originalEnqueue = queues.workflows.enqueue.bind(queues.workflows)
    queues.workflows.enqueue = async (params) => {
      callCount++
      if (callCount === 1) {
        throw new Error("Transient workflow enqueue failure")
      }
      return originalEnqueue(params)
    }

    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "workflows",
            job: {
              type: "workflow.run.requested",
              payload: { workflowId: "workflow-will-fail", input: {} },
            },
          },
          {
            queue: "pipelines",
            job: { type: "pipeline.run.requested", payload: { pipelineId: "pipe-should-succeed" } },
          },
        ],
      ],
    ])

    await startWorker(events, queues, routes)

    await events.append({
      events: [makeScheduleTriggeredEvent("daily")],
    })

    await waitFor(async () => {
      const claimed = await queues.pipelines.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      return claimed.length === 1
    })

    const workflowClaimed = await queues.workflows.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(workflowClaimed).toHaveLength(0)
  })

  test("robustness: orchestrator continues consuming after an enqueue failure", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const originalError = console.error
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    let callCount = 0
    const originalEnqueue = queues.syncRuns.enqueue.bind(queues.syncRuns)
    queues.syncRuns.enqueue = async (params) => {
      callCount++
      if (callCount === 1) {
        throw new Error("Transient enqueue failure")
      }
      return originalEnqueue(params)
    }

    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-orders" } },
          },
        ],
      ],
    ])

    try {
      await startWorker(events, queues, routes)

      // First event — enqueue will fail
      await events.append({
        events: [makeScheduleTriggeredEvent("daily", "2026-04-18T02:00:00.000Z")],
      })

      await Bun.sleep(50)

      // Second event — enqueue should succeed
      await events.append({
        events: [makeScheduleTriggeredEvent("daily", "2026-04-19T02:00:00.000Z")],
      })

      await waitFor(async () => {
        const claimed = await queues.syncRuns.claim({
          projectId: PROJECT_ID,
          workerId: "observer",
        })
        return claimed.length === 1
      })
      expect(String(errors[0]?.[0])).toContain("[SixbOrchestrator] Enqueue failed")
      expect(errors[0]?.[1]).toBeInstanceOf(Error)
    } finally {
      console.error = originalError
    }
  })

  test("live-only: events appended before start() are never enqueued", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-orders" } },
          },
        ],
      ],
    ])

    // Append BEFORE starting the orchestrator
    await events.append({
      events: [makeScheduleTriggeredEvent("daily")],
    })

    await startWorker(events, queues, routes)

    // Wait a bit to ensure any potential processing would have happened
    await Bun.sleep(50)

    const claimed = await queues.syncRuns.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })

  test("projectId isolation: events from another project are ignored", async () => {
    const broker = new InMemoryBroker()
    const events = createEvents(PROJECT_ID, broker)
    const otherEvents = createEvents("other-project", broker)
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "schedule.triggered:daily",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-orders" } },
          },
        ],
      ],
    ])

    await startWorker(events, queues, routes, PROJECT_ID)

    // Append under a different projectId
    await otherEvents.append({
      events: [makeScheduleTriggeredEvent("daily")],
    })

    await Bun.sleep(50)

    const claimed = await queues.syncRuns.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })

  test("throws OrchestratorError when projectId is empty", () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([])

    expect(() => new OrchestratorWorker({ projectId: "", events, queues, routes })).toThrow(
      "[SixbOrchestrator] projectId is required."
    )
  })

  test("sync.run.finished event triggers a downstream pipeline job", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "sync.run.finished:sync-orders:succeeded",
        [
          {
            queue: "pipelines",
            job: { type: "pipeline.run.requested", payload: { pipelineId: "normalize-orders" } },
          },
        ],
      ],
    ])

    const worker = new OrchestratorWorker({
      projectId: PROJECT_ID,
      events,
      queues,
      routes,
    })
    workers.push(worker)
    await worker.start()

    await events.append({
      events: [
        {
          type: "sync.run.finished",
          payload: {
            syncId: "sync-orders",
            runId: "run-1",
            status: "succeeded" as const,
            datasetId: "raw.erp.orders",
            versionId: "v-1",
          },
        },
      ],
    })

    await worker.stop()

    const pipelineJobs = await queues.pipelines.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(pipelineJobs).toHaveLength(1)
    expect(pipelineJobs[0]!.job.payload.pipelineId).toBe("normalize-orders")
  })

  test("dataset.version.committed event triggers a downstream pipeline job", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "dataset.version.committed:raw.erp.orders",
        [
          {
            queue: "pipelines",
            job: { type: "pipeline.run.requested", payload: { pipelineId: "normalize-orders" } },
          },
        ],
      ],
    ])

    const worker = new OrchestratorWorker({
      projectId: PROJECT_ID,
      events,
      queues,
      routes,
    })
    workers.push(worker)
    await worker.start()

    await events.append({
      events: [
        {
          type: "dataset.version.committed",
          payload: {
            datasetId: "raw.erp.orders",
            versionId: "v-1",
            producer: { kind: "sync", id: "sync-orders", runId: "run-1" },
          },
        },
      ],
    })

    await worker.stop()

    const pipelineJobs = await queues.pipelines.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(pipelineJobs).toHaveLength(1)
    expect(pipelineJobs[0]!.job.payload.pipelineId).toBe("normalize-orders")
    expect(pipelineJobs[0]!.job.metadata).toMatchObject({
      sourceEventType: "dataset.version.committed",
      datasetId: "raw.erp.orders",
      versionId: "v-1",
      producerKind: "sync",
      producerId: "sync-orders",
      producerRunId: "run-1",
    })
  })

  test("dataset.version.committed event triggers a projection job", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "dataset.version.committed:canonical.rooms",
        [
          {
            queue: "projections",
            job: {
              type: "projection.run.requested",
              payload: {
                projectionId: "room-proj",
                projectionKind: "object",
                datasetId: "canonical.rooms",
              },
            },
          },
        ],
      ],
    ])

    const worker = new OrchestratorWorker({
      projectId: PROJECT_ID,
      events,
      queues,
      routes,
    })
    workers.push(worker)
    await worker.start()

    const [stored] = await events.append({
      events: [makeDatasetVersionCommittedEvent("canonical.rooms", "ver-room-1")],
    })

    await worker.stop()

    const projectionJobs = await queues.projections.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(projectionJobs).toHaveLength(1)
    expect(projectionJobs[0]!.job.payload).toEqual({
      projectionId: "room-proj",
      projectionKind: "object",
      datasetId: "canonical.rooms",
      versionId: "ver-room-1",
    })
    expect(projectionJobs[0]!.job.metadata).toMatchObject({
      sourceEventId: stored!.id,
      sourceEventType: "dataset.version.committed",
      datasetId: "canonical.rooms",
      versionId: "ver-room-1",
      producerKind: "sync",
      producerId: "sync-orders",
      producerRunId: "run-1",
    })
  })

  test("dataset.version.committed event fans out to object and link projection jobs", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "dataset.version.committed:canonical.rooms",
        [
          {
            queue: "projections",
            job: {
              type: "projection.run.requested",
              payload: {
                projectionId: "room-proj",
                projectionKind: "object",
                datasetId: "canonical.rooms",
              },
            },
          },
          {
            queue: "projections",
            job: {
              type: "projection.run.requested",
              payload: {
                projectionId: "room-sensors",
                projectionKind: "link",
                datasetId: "canonical.rooms",
              },
            },
          },
        ],
      ],
    ])

    const worker = new OrchestratorWorker({
      projectId: PROJECT_ID,
      events,
      queues,
      routes,
    })
    workers.push(worker)
    await worker.start()

    await events.append({
      events: [makeDatasetVersionCommittedEvent("canonical.rooms", "ver-room-1")],
    })

    await worker.stop()

    const projectionJobs = await queues.projections.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
      limit: 10,
    })
    expect(projectionJobs).toHaveLength(2)
    expect(projectionJobs.map((claimed) => claimed.job.payload)).toEqual([
      {
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: "ver-room-1",
      },
      {
        projectionId: "room-sensors",
        projectionKind: "link",
        datasetId: "canonical.rooms",
        versionId: "ver-room-1",
      },
    ])
  })

  test("dataset.version.committed for unrelated dataset produces no projection job", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "dataset.version.committed:canonical.rooms",
        [
          {
            queue: "projections",
            job: {
              type: "projection.run.requested",
              payload: {
                projectionId: "room-proj",
                projectionKind: "object",
                datasetId: "canonical.rooms",
              },
            },
          },
        ],
      ],
    ])

    await startWorker(events, queues, routes)

    await events.append({
      events: [makeDatasetVersionCommittedEvent("raw.erp.orders", "v-raw-1")],
    })

    await Bun.sleep(50)

    const projectionJobs = await queues.projections.claim({
      projectId: PROJECT_ID,
      workerId: "observer",
    })
    expect(projectionJobs).toHaveLength(0)
  })

  test("robustness: projection enqueue failure does not drop sibling pipeline jobs", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const originalError = console.error
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    let callCount = 0
    const originalEnqueue = queues.projections.enqueue.bind(queues.projections)
    queues.projections.enqueue = async (params) => {
      callCount++
      if (callCount === 1) {
        throw new Error("Transient projection enqueue failure")
      }
      return originalEnqueue(params)
    }

    const routes = buildRoutes([
      [
        "dataset.version.committed:canonical.rooms",
        [
          {
            queue: "projections",
            job: {
              type: "projection.run.requested",
              payload: {
                projectionId: "room-proj",
                projectionKind: "object",
                datasetId: "canonical.rooms",
              },
            },
          },
          {
            queue: "pipelines",
            job: { type: "pipeline.run.requested", payload: { pipelineId: "normalize-rooms" } },
          },
        ],
      ],
    ])

    try {
      await startWorker(events, queues, routes)

      await events.append({
        events: [makeDatasetVersionCommittedEvent("canonical.rooms", "ver-room-1")],
      })

      await waitFor(async () => {
        const pipelineJobs = await queues.pipelines.claim({
          projectId: PROJECT_ID,
          workerId: "observer",
        })
        return pipelineJobs.length === 1
      })

      const projectionJobs = await queues.projections.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      expect(projectionJobs).toHaveLength(0)
      expect(String(errors[0]?.[0])).toContain("[SixbOrchestrator] Enqueue failed")
      expect(errors[0]?.[1]).toBeInstanceOf(Error)
    } finally {
      console.error = originalError
    }
  })

  test("metadata: sync.run.finished carries syncId, runId, and status", async () => {
    const events = createEvents()
    const queues = new InMemoryQueues()
    const routes = buildRoutes([
      [
        "sync.run.finished:sync-orders:succeeded",
        [
          {
            queue: "syncRuns",
            job: { type: "sync.run.requested", payload: { syncId: "sync-downstream" } },
          },
        ],
      ],
    ])

    const worker = new OrchestratorWorker({
      projectId: PROJECT_ID,
      events,
      queues,
      routes,
    })
    workers.push(worker)
    await worker.start()

    await events.append({
      events: [
        {
          type: "sync.run.finished",
          payload: {
            syncId: "sync-orders",
            runId: "run-42",
            status: "succeeded" as const,
          },
        },
      ],
    })

    await waitFor(async () => {
      const claimed = await queues.syncRuns.claim({
        projectId: PROJECT_ID,
        workerId: "observer",
      })
      if (claimed.length === 0) return false

      const meta = claimed[0]!.job.metadata
      expect(meta).toBeDefined()
      expect(meta!.sourceEventType).toBe("sync.run.finished")
      expect(meta!.syncId).toBe("sync-orders")
      expect(meta!.runId).toBe("run-42")
      expect(meta!.status).toBe("succeeded")
      return true
    })
  })
})
