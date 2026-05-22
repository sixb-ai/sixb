import { describe, expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  type DatasetRow,
  datasetUpdated,
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
  type EventsRuntime,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LakeStorage,
  Pario,
  prop,
  type RuleDefinition,
  type StorageMigrator,
} from "@pario/core"
import { startParioRuntime } from "../src/lib/runtime"

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
  pario: { readonly id: string; readonly events: EventsRuntime },
  scheduleId: string
) {
  const occurrenceAt = "2026-04-18T02:00:00.000Z"
  await pario.events.append({
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

describe("startParioRuntime", () => {
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

    const pario = new Pario({
      id: "cli-with-migrations",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage,
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })

    const runtime = await startParioRuntime(pario)

    expect(calls).toEqual(["storage"])

    await runtime.stop()
  })

  test("skips workers when cohostWorkers is true but no definitions are registered", async () => {
    const pario = new Pario({
      id: "cli-no-workers",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })

    const runtime = await startParioRuntime(pario, { cohostWorkers: true })

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
    const pario = new Pario({
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

    const runtime = await startParioRuntime(pario, { cohostWorkers: false })

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
    const pario = new Pario({
      id: "cli-lake-definition-drift",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [changedDataset],
    })

    await expect(startParioRuntime(pario, { cohostWorkers: true })).rejects.toThrow(
      "Lake dataset definition check failed"
    )
  })

  test("skips the projection worker when cohostWorkers is true but no projections are registered", async () => {
    const pario = new Pario({
      id: "cli-no-projections",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })

    const runtime = await startParioRuntime(pario, { cohostWorkers: true })

    expect(runtime.projectionWorker).toBeNull()

    await runtime.stop()
  })

  test("does not co-host the projection worker unless explicitly enabled", async () => {
    const projection = defineProjection("zone-proj", Zone)
      .fromDataset(rawOrdersDataset)
      .properties({ id: "orderId" })
    const pario = new Pario({
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

    const runtime = await startParioRuntime(pario, { cohostWorkers: false })

    expect(runtime.projectionWorker).toBeNull()

    await runtime.stop()
  })

  test("does not co-host the workflow worker unless explicitly enabled", async () => {
    const workflow = defineWorkflow("runtime-manual-workflow").input({}).then(workflowStep)
    const pario = new Pario({
      id: "cli-no-workflow-worker",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      workflows: [workflow],
    })

    const runtime = await startParioRuntime(pario, { cohostWorkers: false })

    expect(runtime.workflowWorker).toBeNull()

    await runtime.stop()
  })

  test("co-hosts the sync worker when enabled and syncs are registered", async () => {
    const sync = defineSync("sync-orders")
      .from(erpDb)
      .read(() => [{ orderId: "ord_1" }])
      .intoDataset(rawOrdersDataset)
    const pario = new Pario({
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

    const runtime = await startParioRuntime(pario, { cohostWorkers: true })

    expect(runtime.syncWorker).not.toBeNull()

    await pario.queues.syncRuns.enqueue({
      projectId: pario.id,
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
      () => pario.storage.syncRuns!.getById({ projectId: pario.id, id: "runtime-sync-1" }),
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
    const pipeline = definePipeline("normalize-orders")
      .when(datasetUpdated(rawOrdersDataset.id))
      .then(normalizeStep)
    const pario = new Pario({
      id: "cli-with-pipeline-worker",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [rawOrdersDataset, canonicalOrdersDataset],
      pipelines: [pipeline],
    })

    let runtime: Awaited<ReturnType<typeof startParioRuntime>> | null = null
    try {
      runtime = await startParioRuntime(pario, { cohostWorkers: true })

      expect(runtime.pipelineWorker).not.toBeNull()
      expect(runtime.warnings).toHaveLength(0)

      await pario.queues.pipelines.enqueue({
        projectId: pario.id,
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
          pario.storage.pipelineRuns!.getById({
            projectId: pario.id,
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
    const pario = new Pario({
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
    const version = await seedDatasetVersion(pario.lakeStorage, rawOrdersDataset, [
      { orderId: "ord_1" },
    ])

    let runtime: Awaited<ReturnType<typeof startParioRuntime>> | null = null
    try {
      runtime = await startParioRuntime(pario, { cohostWorkers: true })
      expect(runtime.projectionWorker).not.toBeNull()

      await pario.events.append({
        events: [
          {
            type: "dataset.version.committed",
            payload: {
              datasetId: "raw.erp.orders",
              versionId: version.versionId,
              producer: { kind: "sync", id: "sync-orders", runId: "run-1" },
            },
          },
        ],
      })

      const object = await waitFor(
        () =>
          pario.storage.objects.getByPrimaryId({
            projectId: pario.id,
            objectTypeId: "Zone",
            primaryId: "ord_1",
          }),
        (value) => value !== null
      )

      expect(object?.properties.id).toBe("ord_1")

      const projectionRuns = await waitFor(
        () =>
          pario.storage.projectionRuns!.list({
            projectId: pario.id,
            projectionId: "zone-proj",
            datasetVersionId: version.versionId,
            statuses: ["succeeded"],
          }),
        (value) => value.total === 1
      )
      expect(projectionRuns.runs[0]?.objectsUpserted).toBe(1)

      const projectionJobs = await pario.queues.projections.claim({
        projectId: pario.id,
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
    const pipeline = definePipeline("normalize-orders")
      .when(datasetUpdated("raw.erp.orders"))
      .then(normalizeOrders)
    const pario = new Pario({
      id: "cli-with-pipeline-route",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      datasets: [rawOrdersDataset, canonicalOrdersDataset],
      pipelines: [pipeline],
    })

    let runtime: Awaited<ReturnType<typeof startParioRuntime>> | null = null
    try {
      runtime = await startParioRuntime(pario, { cohostWorkers: true })

      expect(runtime.pipelineWorker).not.toBeNull()
      expect(runtime.orchestratorWorker).not.toBeNull()
      expect(runtime.warnings).toHaveLength(0)

      await pario.events.append({
        events: [
          {
            type: "dataset.version.committed",
            payload: {
              datasetId: rawOrdersDataset.id,
              versionId: version.versionId,
              producer: { kind: "sync", id: "sync-orders", runId: "run-1" },
            },
          },
        ],
      })

      const runs = await waitFor(
        () =>
          pario.storage.pipelineRuns!.list({
            projectId: pario.id,
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
    const pario = new Pario({
      id: "cli-with-workflow-worker",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      workflows: [workflow],
    })

    const runtime = await startParioRuntime(pario, { cohostWorkers: true })

    expect(runtime.workflowWorker).not.toBeNull()

    await runtime.stop()
  })

  test("routes and executes scheduled empty-input workflows in dev runtime", async () => {
    const daily = defineSchedule("runtime-workflow-daily").cron("0 2 * * *")
    const workflow = defineWorkflow("runtime-scheduled-workflow")
      .input({})
      .when(daily)
      .then(workflowStep)
    const pario = new Pario({
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

    let runtime: Awaited<ReturnType<typeof startParioRuntime>> | null = null
    try {
      runtime = await startParioRuntime(pario, { cohostWorkers: true })
      expect(runtime.workflowWorker).not.toBeNull()
      expect(runtime.orchestratorWorker).not.toBeNull()
      expect(runtime.warnings).toHaveLength(0)

      await appendScheduleTriggered(pario, daily.id)

      const workflowRuns = await waitFor(
        () =>
          pario.storage.workflowRuns!.list({
            projectId: pario.id,
            workflowId: workflow.id,
            statuses: ["succeeded"],
          }),
        (value) => value.total === 1
      )

      expect(workflowRuns.runs[0]?.input).toEqual({})

      const workflowJobs = await pario.queues.workflows.claim({
        projectId: pario.id,
        workerId: "observer",
      })
      expect(workflowJobs).toHaveLength(0)
    } finally {
      await runtime?.stop()
    }
  })

  test("warns and skips scheduled workflows with non-empty input", async () => {
    const daily = defineSchedule("runtime-required-workflow-daily").cron("0 2 * * *")
    const workflow = defineWorkflow("runtime-required-workflow")
      .input({ accountId: "string" })
      .when(daily)
      .then(workflowStep, () => ({}))
    const pario = new Pario({
      id: "cli-with-skipped-workflow-route",
      ontology: [Zone],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      schedules: [daily],
      workflows: [workflow],
    })

    let runtime: Awaited<ReturnType<typeof startParioRuntime>> | null = null
    try {
      runtime = await startParioRuntime(pario, { cohostWorkers: true })

      expect(runtime.workflowWorker).not.toBeNull()
      expect(runtime.orchestratorWorker).toBeNull()
      expect(runtime.warnings).toContain(
        "[Pario] Workflow 'runtime-required-workflow' is scheduled but has non-empty input (accountId); it was not auto-routed."
      )

      await appendScheduleTriggered(pario, daily.id)

      const workflowJobs = await pario.queues.workflows.claim({
        projectId: pario.id,
        workerId: "observer",
      })
      expect(workflowJobs).toHaveLength(0)
    } finally {
      await runtime?.stop()
    }
  })

  test("co-hosts the rules worker when rules are registered", async () => {
    const broker = new InMemoryBroker()
    const pario = new Pario({
      id: "cli-with-rules-worker",
      ontology: [Transaction],
      broker,
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      rules: [postedRule],
    })

    const runtime = await startParioRuntime(pario)

    expect(runtime.rulesWorker).not.toBeNull()

    await pario.events.append({
      events: [
        {
          type: "object.upserted",
          payload: {
            objectTypeId: "Transaction",
            primaryId: "tx-1",
            properties: { status: "posted" },
          },
        },
      ],
    })

    const events = await waitFor(
      () => pario.events.read({ topics: ["rules"] }),
      (value) => value.length === 1
    )

    expect(events[0]?.type).toBe("rule.triggered")

    await runtime.stop()
  })

  test("stops the rules worker after functions and closes runtime providers", async () => {
    const calls: string[] = []
    const broker = new LifecycleBroker(calls)
    const pario = new Pario({
      id: "cli-rules-lifecycle-order",
      ontology: [Transaction],
      broker,
      storage: new InMemoryStorage(),
      lakeStorage: createLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      rules: [postedRule],
    })
    pario.startFunctions = async () => {
      calls.push("functions:start")
    }
    pario.stopFunctions = async () => {
      calls.push("functions:stop")
    }
    pario.disconnectConnectors = async () => {
      calls.push("connectors:stop")
    }

    const runtime = await startParioRuntime(pario)

    expect(calls).toEqual(["functions:start", "rules:start"])

    await runtime.stop()

    expect(calls).toEqual([
      "functions:start",
      "rules:start",
      "functions:stop",
      "rules:stop",
      "connectors:stop",
      "broker:stop",
    ])
  })
})

class LifecycleBroker extends InMemoryBroker {
  constructor(private readonly calls: string[]) {
    super()
  }

  override async subscribe(
    params: Parameters<InMemoryBroker["subscribe"]>[0],
    handler: Parameters<InMemoryBroker["subscribe"]>[1]
  ): Promise<() => void> {
    if (params.names?.includes("object.upserted")) {
      this.calls.push("rules:start")
    }

    const unsubscribe = await super.subscribe(params, handler)
    return () => {
      if (params.names?.includes("object.upserted")) {
        this.calls.push("rules:stop")
      }
      unsubscribe()
    }
  }

  async close(): Promise<void> {
    this.calls.push("broker:stop")
  }
}
