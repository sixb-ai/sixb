import { describe, expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  type DatasetRow,
  type DomainEventLog,
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
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LakeStorage,
  type LoggerProvider,
  prop,
  type RuleDefinition,
  Sixb,
  type StorageMigrator,
} from "@sixb/core"
import {
  checkRuntimeLakeDefinitions,
  migrateRuntimeStorage,
  startOrchestratorRuntime,
  startRulesRuntime,
  startSchedulerRuntime,
  startSixbRuntime,
  stopSixbProviders,
} from "../src/lib/runtime"

const Zone = defineObjectType({
  id: "Zone",
  name: "Zone",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("temperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
  ],
})

const Transaction = defineObjectType({
  id: "Transaction",
  name: "Transaction",
  properties: [prop("id", "string", { required: true, primary: true }), prop("status", "string")],
})

const erpDb = defineConnector("erpDb", {
  type: "sql",
  connect() {
    return {}
  },
})

const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [col("orderId", "string", { nullable: true })],
})

const canonicalOrdersDataset = defineDataset("canonical.orders", {
  schema: [col("id", "string", { nullable: true })],
})

const workflowStep = defineWorkflowStep("runtime-workflow-step")
  .input({})
  .output({})
  .run(() => ({}))

const postedRule: RuleDefinition = {
  kind: "rule",
  id: "transaction.posted",
  subject: {
    kind: "object",
    objectTypeId: "Transaction",
  },
  predicate: {
    kind: "property",
    propertyId: "status",
    op: "eq",
    value: "posted",
  },
}

function createLakeStorage() {
  return new InMemoryLakeStorage()
}

async function seedDatasetVersion(
  lakeStorage: LakeStorage,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[]
) {
  await lakeStorage.createDataset(dataset)
  const write = await lakeStorage.beginWrite({ dataset, mode: "snapshot" })
  await write.writeRows(rows)
  return write.commit({ commitMessage: `seed ${dataset.id}` })
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000
): Promise<T> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn()
    if (predicate(value)) {
      return value
    }

    await Bun.sleep(20)
  }

  throw new Error("Timed out waiting for condition.")
}

async function appendScheduleTriggered(
  sixb: { readonly id: string; readonly events: DomainEventLog },
  scheduleId: string
) {
  const occurrenceAt = "2026-04-18T02:00:00.000Z"
  await sixb.events.append({
    events: [
      {
        type: "schedule.triggered",
        payload: {
          scheduleId,
          occurrenceAt,
          triggeredAt: occurrenceAt,
          occurrenceKey: `${scheduleId}:${occurrenceAt}`,
        },
      },
    ],
  })
}

describe("startSixbRuntime", () => {
  test("runs adapter migrations before starting background runtimes", async () => {
    const calls: string[] = []
    const migrator: StorageMigrator = {
      adapterId: "FixtureStorage",
      latestVersion: 1,
      async plan() {
        throw new Error("plan should not run")
      },
      async migrate() {
        calls.push("storage")
        return {
          adapterId: "FixtureStorage",
          latestVersion: 1,
          status: "migrated",
          applied: ["001-fixture"],
          skipped: [],
        }
      },
    }
    const storage = Object.assign(new InMemoryStorage(), { migrators: [migrator] })

    const sixb = new Sixb({
      id: "cli-with-migrations",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage,
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })

    const runtime = await startSixbRuntime(sixb)

    expect(calls).toEqual(["storage"])

    await runtime.stop()
  })

  test("skips workers when cohostWorkers is true but no definitions are registered", async () => {
    const sixb = new Sixb({
      id: "cli-no-workers",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })

    const runtime = await startSixbRuntime(sixb, { cohostWorkers: true })

    expect(runtime.rulesWorker).toBeNull()
    expect(runtime.syncWorker).toBeNull()
    expect(runtime.actionWorker).toBeNull()
    expect(runtime.projectionWorker).toBeNull()
    expect(runtime.pipelineWorker).toBeNull()
    expect(runtime.workflowWorker).toBeNull()
    expect(runtime.orchestratorWorker).toBeNull()
    expect(runtime.warnings).toHaveLength(0)

    await runtime.stop()
  })

  test("does not co-host the sync worker unless explicitly enabled", async () => {
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [])
      .intoDataset(rawOrdersDataset)
    const sixb = new Sixb({
      id: "cli-no-sync-worker",
      ontology: [Zone],
      connectors: [erpDb],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [rawOrdersDataset],
      syncs: [sync],
    })

    const runtime = await startSixbRuntime(sixb, { cohostWorkers: false })

    expect(runtime.rulesWorker).toBeNull()
    expect(runtime.syncWorker).toBeNull()

    await runtime.stop()
  })

  test("fails startup when runtime datasets are incompatible with lake storage", async () => {
    const lakeStorage = createLakeStorage()
    await lakeStorage.createDataset(rawOrdersDataset)

    const changedDataset = defineDataset("raw.erp.orders", {
      schema: [
        col("orderId", "string", { nullable: true }),
        col("currency", "string", { nullable: true }),
      ],
    })
    const sixb = new Sixb({
      id: "cli-lake-definition-drift",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [changedDataset],
    })

    await expect(startSixbRuntime(sixb, { cohostWorkers: true })).rejects.toThrow(
      "Lake dataset definition check failed"
    )
  })

  test("skips the projection worker when cohostWorkers is true but no projections are registered", async () => {
    const sixb = new Sixb({
      id: "cli-no-projections",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })

    const runtime = await startSixbRuntime(sixb, { cohostWorkers: true })

    expect(runtime.projectionWorker).toBeNull()

    await runtime.stop()
  })

  test("does not co-host the projection worker unless explicitly enabled", async () => {
    const projection = defineProjection("zone-proj", Zone)
      .fromDataset(rawOrdersDataset)
      .properties({ id: "orderId" })
    const sixb = new Sixb({
      id: "cli-no-projection-worker",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [rawOrdersDataset],
      projections: [projection],
    })

    const runtime = await startSixbRuntime(sixb, { cohostWorkers: false })

    expect(runtime.projectionWorker).toBeNull()

    await runtime.stop()
  })

  test("does not co-host the workflow worker unless explicitly enabled", async () => {
    const workflow = defineWorkflow("runtime-manual-workflow").input({}).then(workflowStep)
    const sixb = new Sixb({
      id: "cli-no-workflow-worker",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      workflows: [workflow],
    })

    const runtime = await startSixbRuntime(sixb, { cohostWorkers: false })

    expect(runtime.workflowWorker).toBeNull()

    await runtime.stop()
  })

  test("co-hosts the sync worker when enabled and syncs are registered", async () => {
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [{ orderId: "ord_1" }])
      .intoDataset(rawOrdersDataset)
    const sixb = new Sixb({
      id: "cli-with-sync-worker",
      ontology: [Zone],
      connectors: [erpDb],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [rawOrdersDataset],
      syncs: [sync],
    })

    const runtime = await startSixbRuntime(sixb, { cohostWorkers: true })

    expect(runtime.syncWorker).not.toBeNull()

    await sixb.queues.syncRuns.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "sync.run.requested",
          payload: {
            syncId: "sync-orders",
            runId: "runtime-sync-1",
          },
        },
      ],
    })

    const run = await waitFor(
      () => sixb.storage.syncRuns!.getById({ projectId: sixb.id, id: "runtime-sync-1" }),
      (value) => value?.status === "succeeded"
    )

    expect(run?.status).toBe("succeeded")

    await runtime.stop()
  })

  test("co-hosts the pipeline worker when enabled and pipelines are registered", async () => {
    const lakeStorage = createLakeStorage()
    await seedDatasetVersion(lakeStorage, rawOrdersDataset, [{ orderId: "ord_1" }])

    const normalizeStep = definePipelineStep("normalize-orders")
      .inputs({ rawOrders: rawOrdersDataset })
      .output(canonicalOrdersDataset)
      .run(async ({ inputs, output }) => {
        async function* rows() {
          for await (const row of inputs.rawOrders.readRows()) {
            yield { id: row.orderId }
          }
        }

        await output.writeRows(rows())
      })
    const rawOrdersUpdated = defineSchedule("raw-orders-updated").on(
      events.dataset(rawOrdersDataset).updated()
    )
    const pipeline = definePipeline("normalize-orders").when(rawOrdersUpdated).then(normalizeStep)
    const sixb = new Sixb({
      id: "cli-with-pipeline-worker",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [rawOrdersDataset, canonicalOrdersDataset],
      schedules: [rawOrdersUpdated],
      pipelines: [pipeline],
    })

    let runtime: Awaited<ReturnType<typeof startSixbRuntime>> | null = null
    try {
      runtime = await startSixbRuntime(sixb, { cohostWorkers: true })

      expect(runtime.pipelineWorker).not.toBeNull()
      expect(runtime.warnings).toHaveLength(0)

      await sixb.queues.pipelines.enqueue({
        projectId: sixb.id,
        jobs: [
          {
            type: "pipeline.run.requested",
            payload: {
              pipelineId: "normalize-orders",
              runId: "runtime-pipeline-1",
            },
          },
        ],
      })

      const run = await waitFor(
        () =>
          sixb.storage.pipelineRuns!.getById({
            projectId: sixb.id,
            id: "runtime-pipeline-1",
          }),
        (value) => value?.status === "succeeded"
      )

      expect(run?.output?.datasetId).toBe("canonical.orders")
    } finally {
      await runtime?.stop()
    }
  })

  test("co-hosts projection routes and enqueues projection jobs from dataset commits", async () => {
    const projection = defineProjection("zone-proj", Zone)
      .fromDataset(rawOrdersDataset)
      .properties({ id: "orderId" })
    const sixb = new Sixb({
      id: "cli-with-projection-route",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [rawOrdersDataset],
      projections: [projection],
    })
    const version = await seedDatasetVersion(sixb.lakeStorage, rawOrdersDataset, [
      { orderId: "ord_1" },
    ])

    let runtime: Awaited<ReturnType<typeof startSixbRuntime>> | null = null
    try {
      runtime = await startSixbRuntime(sixb, { cohostWorkers: true })
      expect(runtime.projectionWorker).not.toBeNull()

      await sixb.events.append({
        events: [
          {
            type: "dataset.version.committed",
            payload: {
              datasetId: "raw.erp.orders",
              versionId: version.versionId,
              createdAt: version.createdAt.toISOString(),
              producer: { kind: "sync", id: "sync-orders", runId: "run-1" },
            },
          },
        ],
      })

      const object = await waitFor(
        () =>
          sixb.storage.objects.getByPrimaryId({
            projectId: sixb.id,
            objectTypeId: "Zone",
            primaryId: "ord_1",
          }),
        (value) => value !== null
      )

      expect(object?.properties.id).toBe("ord_1")

      const projectionRuns = await waitFor(
        () =>
          sixb.storage.projectionRuns!.list({
            projectId: sixb.id,
            projectionId: "zone-proj",
            datasetVersionId: version.versionId,
            statuses: ["succeeded"],
          }),
        (value) => value.total === 1
      )
      expect(projectionRuns.runs[0]?.sourceRowsRead).toBe(1)

      const projectionJobs = await sixb.queues.projections.claim({
        projectId: sixb.id,
        workerId: "observer",
      })
      expect(projectionJobs).toHaveLength(0)
      expect(runtime.warnings).toHaveLength(0)
    } finally {
      await runtime?.stop()
    }
  })

  test("co-hosts pipeline routes and executes pipeline jobs from dataset commits", async () => {
    const lakeStorage = createLakeStorage()
    const version = await seedDatasetVersion(lakeStorage, rawOrdersDataset, [{ orderId: "ord_1" }])

    const normalizeOrders = definePipelineStep("normalize-orders-step")
      .inputs({ rawOrders: rawOrdersDataset })
      .output(canonicalOrdersDataset)
      .run(async ({ inputs, output }) => {
        async function* rows() {
          for await (const row of inputs.rawOrders.readRows()) {
            yield { id: row.orderId }
          }
        }

        await output.writeRows(rows())
      })
    const rawOrdersUpdated = defineSchedule("raw-orders-updated").on(
      events.dataset(rawOrdersDataset).updated()
    )
    const pipeline = definePipeline("normalize-orders").when(rawOrdersUpdated).then(normalizeOrders)
    const sixb = new Sixb({
      id: "cli-with-pipeline-route",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [rawOrdersDataset, canonicalOrdersDataset],
      schedules: [rawOrdersUpdated],
      pipelines: [pipeline],
    })

    let runtime: Awaited<ReturnType<typeof startSixbRuntime>> | null = null
    try {
      runtime = await startSixbRuntime(sixb, { cohostWorkers: true })

      expect(runtime.pipelineWorker).not.toBeNull()
      expect(runtime.orchestratorWorker).not.toBeNull()
      expect(runtime.warnings).toHaveLength(0)

      await sixb.events.append({
        events: [
          {
            type: "dataset.version.committed",
            payload: {
              datasetId: rawOrdersDataset.id,
              versionId: version.versionId,
              createdAt: version.createdAt.toISOString(),
              producer: { kind: "sync", id: "sync-orders", runId: "run-1" },
            },
          },
        ],
      })

      const runs = await waitFor(
        () =>
          sixb.storage.pipelineRuns!.list({
            projectId: sixb.id,
            pipelineId: "normalize-orders",
            statuses: ["succeeded"],
          }),
        (value) => value.total === 1
      )
      expect(runs.runs[0]?.output?.datasetId).toBe("canonical.orders")
    } finally {
      await runtime?.stop()
    }
  })

  test("co-hosts the workflow worker when enabled and workflows are registered", async () => {
    const workflow = defineWorkflow("runtime-manual-workflow").input({}).then(workflowStep)
    const sixb = new Sixb({
      id: "cli-with-workflow-worker",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      workflows: [workflow],
    })

    const runtime = await startSixbRuntime(sixb, { cohostWorkers: true })

    expect(runtime.workflowWorker).not.toBeNull()

    await runtime.stop()
  })

  test("routes and executes scheduled empty-input workflows in dev runtime", async () => {
    const daily = defineSchedule("runtime-workflow-daily").cron("0 2 * * *")
    const workflow = defineWorkflow("runtime-scheduled-workflow")
      .input({})
      .when(daily)
      .then(workflowStep)
    const sixb = new Sixb({
      id: "cli-with-workflow-route",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      schedules: [daily],
      workflows: [workflow],
    })

    let runtime: Awaited<ReturnType<typeof startSixbRuntime>> | null = null
    try {
      runtime = await startSixbRuntime(sixb, { cohostWorkers: true })
      expect(runtime.workflowWorker).not.toBeNull()
      expect(runtime.orchestratorWorker).not.toBeNull()
      expect(runtime.warnings).toHaveLength(0)

      await appendScheduleTriggered(sixb, daily.id)

      const workflowRuns = await waitFor(
        () =>
          sixb.storage.workflowRuns!.list({
            projectId: sixb.id,
            workflowId: workflow.id,
            statuses: ["succeeded"],
          }),
        (value) => value.total === 1
      )

      expect(workflowRuns.runs[0]?.input).toEqual({})

      const workflowJobs = await sixb.queues.workflows.claim({
        projectId: sixb.id,
        workerId: "observer",
      })
      expect(workflowJobs).toHaveLength(0)
    } finally {
      await runtime?.stop()
    }
  })

  test("co-hosts the rules worker when rules are registered", async () => {
    const broker = new InMemoryBroker()
    const sixb = new Sixb({
      id: "cli-with-rules-worker",
      ontology: [Transaction],
      broker,
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      rules: [postedRule],
    })

    const runtime = await startSixbRuntime(sixb)

    expect(runtime.rulesWorker).not.toBeNull()

    await sixb.upsertObject("Transaction", { id: "tx-1", status: "posted" })

    const events = await waitFor(
      () => sixb.events.read({ topics: ["rules"] }),
      (value) => value.length === 1
    )

    expect(events[0]?.type).toBe("rule.triggered")

    await runtime.stop()
  })

  test("stops the rules worker before closing runtime providers", async () => {
    const calls: string[] = []
    const broker = new LifecycleBroker(calls)
    const sixb = new Sixb({
      id: "cli-rules-lifecycle-order",
      ontology: [Transaction],
      broker,
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      rules: [postedRule],
    })
    sixb.disconnectConnectors = async () => {
      calls.push("connectors:stop")
    }

    const runtime = await startSixbRuntime(sixb)

    expect(calls).toEqual(["rules:start"])

    await runtime.stop()

    expect(calls).toEqual(["rules:start", "rules:stop", "connectors:stop", "broker:stop"])
  })

  test("closes optional provider handles during runtime cleanup", async () => {
    const calls: string[] = []
    const sixb = new Sixb({
      id: "cli-provider-cleanup",
      ontology: [Transaction],
      broker: new LifecycleBroker(calls),
      storage: new ClosableStorage(calls),
      lakeStorage: new ClosableLakeStorage(calls),
      blobStorage: new ClosableBlobStorage(calls),
      queues: new ClosableQueues(calls),
      logger: new ClosableLogger(calls),
    })
    sixb.disconnectConnectors = async () => {
      calls.push("connectors:stop")
    }

    await stopSixbProviders(sixb)

    expect(calls).toEqual([
      "connectors:stop",
      "queues:stop",
      "broker:stop",
      "storage:stop",
      "lake-storage:stop",
      "blob-storage:stop",
      "logger:stop",
    ])
  })
})

describe("split production runtime roles", () => {
  test("starts only the scheduler for the scheduler role", async () => {
    const calls: string[] = []
    const sixb = new Sixb({
      id: "cli-scheduler-role",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      schedules: [defineSchedule("role-daily").cron("0 2 * * *")],
    })
    sixb.startScheduler = async () => {
      calls.push("scheduler:start")
    }
    sixb.stopScheduler = async () => {
      calls.push("scheduler:stop")
    }
    const runtime = await startSchedulerRuntime(sixb)

    expect(calls).toEqual(["scheduler:start"])

    await runtime.stop()

    expect(calls).toEqual(["scheduler:start", "scheduler:stop"])
  })

  test("starts only rules evaluation for the rules role", async () => {
    const calls: string[] = []
    const sixb = new Sixb({
      id: "cli-rules-role",
      ontology: [Transaction],
      broker: new LifecycleBroker(calls),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      rules: [postedRule],
    })
    sixb.startScheduler = async () => {
      calls.push("scheduler:start")
    }

    const runtime = await startRulesRuntime(sixb)

    expect(runtime.rulesWorker).not.toBeNull()
    expect(calls).toEqual(["rules:start"])

    await runtime.stop()

    expect(calls).toEqual(["rules:start", "rules:stop"])
  })

  test("starts only the event orchestrator for the orchestrator role", async () => {
    const calls: string[] = []
    const daily = defineSchedule("role-workflow-daily").cron("0 2 * * *")
    const workflow = defineWorkflow("role-scheduled-workflow")
      .input({})
      .when(daily)
      .then(workflowStep)
    const sixb = new Sixb({
      id: "cli-orchestrator-role",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      schedules: [daily],
      workflows: [workflow],
    })
    sixb.startScheduler = async () => {
      calls.push("scheduler:start")
    }

    const runtime = await startOrchestratorRuntime(sixb)

    expect(runtime.orchestratorWorker).not.toBeNull()
    expect(runtime.warnings).toHaveLength(0)
    expect(calls).toEqual([])

    await runtime.stop()

    expect(calls).toEqual([])
  })
})

describe("split runtime preparation", () => {
  test("migrateRuntimeStorage runs storage migrations without touching lake storage", async () => {
    const calls: string[] = []
    const migrator: StorageMigrator = {
      adapterId: "FixtureStorage",
      latestVersion: 1,
      async plan() {
        throw new Error("plan should not run")
      },
      async migrate() {
        calls.push("storage")
        return {
          adapterId: "FixtureStorage",
          latestVersion: 1,
          status: "migrated",
          applied: ["001-fixture"],
          skipped: [],
        }
      },
    }
    const storage = Object.assign(new InMemoryStorage(), { migrators: [migrator] })
    const lakeStorage = new LakeAccessTrackingStorage(calls)

    const sixb = new Sixb({
      id: "cli-migrate-runtime-storage",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage,
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [rawOrdersDataset],
    })

    await migrateRuntimeStorage(sixb)

    expect(calls).toEqual(["storage"])
  })

  test("checkRuntimeLakeDefinitions reports incompatible lake definitions", async () => {
    const lakeStorage = createLakeStorage()
    await lakeStorage.createDataset(rawOrdersDataset)

    const changedDataset = defineDataset("raw.erp.orders", {
      schema: [
        col("orderId", "string", { nullable: true }),
        col("currency", "string", { nullable: true }),
      ],
    })
    const sixb = new Sixb({
      id: "cli-check-lake-definitions-drift",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [changedDataset],
    })

    await expect(checkRuntimeLakeDefinitions(sixb)).rejects.toThrow(
      "Lake dataset definition check failed"
    )
  })

  test("checkRuntimeLakeDefinitions passes when definitions are compatible", async () => {
    const lakeStorage = createLakeStorage()
    await lakeStorage.createDataset(rawOrdersDataset)

    const sixb = new Sixb({
      id: "cli-check-lake-definitions-ok",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [rawOrdersDataset],
    })

    await checkRuntimeLakeDefinitions(sixb)
  })

  test("service startup helpers can start without calling lake storage", async () => {
    const calls: string[] = []
    const sixb = new Sixb({
      id: "cli-startup-without-lake-access",
      ontology: [Transaction],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new LakeAccessTrackingStorage(calls),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      rules: [postedRule],
    })

    const rules = await startRulesRuntime(sixb)
    const scheduler = await startSchedulerRuntime(sixb)
    const orchestrator = await startOrchestratorRuntime(sixb)

    expect(calls).toEqual([])

    await orchestrator.stop()
    await scheduler.stop()
    await rules.stop()
  })
})

class LakeAccessTrackingStorage extends InMemoryLakeStorage {
  constructor(private readonly calls: string[]) {
    super()
  }

  override async createDataset(
    ...args: Parameters<InMemoryLakeStorage["createDataset"]>
  ): ReturnType<InMemoryLakeStorage["createDataset"]> {
    this.calls.push("lake:createDataset")
    return super.createDataset(...args)
  }

  override async getDataset(
    ...args: Parameters<InMemoryLakeStorage["getDataset"]>
  ): ReturnType<InMemoryLakeStorage["getDataset"]> {
    this.calls.push("lake:getDataset")
    return super.getDataset(...args)
  }
}

class LifecycleBroker extends InMemoryBroker {
  constructor(private readonly calls: string[]) {
    super()
  }

  override async subscribe(
    params: Parameters<InMemoryBroker["subscribe"]>[0],
    handler: Parameters<InMemoryBroker["subscribe"]>[1]
  ): Promise<() => void> {
    if (params.names?.includes("object.created")) {
      this.calls.push("rules:start")
    }

    const unsubscribe = await super.subscribe(params, handler)
    return () => {
      if (params.names?.includes("object.created")) {
        this.calls.push("rules:stop")
      }
      unsubscribe()
    }
  }

  async close(): Promise<void> {
    this.calls.push("broker:stop")
  }
}

class ClosableLogger implements LoggerProvider {
  constructor(private readonly calls: string[]) {}

  write(): void {}

  async close(): Promise<void> {
    this.calls.push("logger:stop")
  }
}

class ClosableStorage extends InMemoryStorage {
  constructor(private readonly calls: string[]) {
    super()
  }

  async close(): Promise<void> {
    this.calls.push("storage:stop")
  }
}

class ClosableLakeStorage extends InMemoryLakeStorage {
  constructor(private readonly calls: string[]) {
    super()
  }

  async close(): Promise<void> {
    this.calls.push("lake-storage:stop")
  }
}

class ClosableBlobStorage extends InMemoryBlobStorage {
  constructor(private readonly calls: string[]) {
    super()
  }

  async close(): Promise<void> {
    this.calls.push("blob-storage:stop")
  }
}

class ClosableQueues extends InMemoryQueues {
  constructor(private readonly calls: string[]) {
    super()
  }

  async close(): Promise<void> {
    this.calls.push("queues:stop")
  }
}
