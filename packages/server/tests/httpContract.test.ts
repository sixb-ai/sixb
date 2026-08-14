import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  col,
  type DomainEventLog,
  defineAction,
  defineConnector,
  defineDataset,
  defineIntervention,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineRule,
  defineSchedule,
  defineSync,
  defineWebhook,
  defineWorkflow,
  defineWorkflowStep,
  events,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  interventionField,
  link,
  type OntologySource,
  param,
  prop,
  SixbHost,
  type SixbHostOptions,
  type Storage,
  type WorkflowDefinition,
} from "@sixb/core"
import { createTestSixb, createTestWorkflowExecution } from "@sixb/core/testing"
import { SqliteStorage } from "@sixb/sqlite"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

function createSixbInstance<TOntologySources extends readonly OntologySource[]>(
  options: SixbHostOptions<TOntologySources>
): SixbHost<TOntologySources> {
  return new SixbHost<TOntologySources>(options)
}

const Space = defineObjectType({
  id: "space",
  name: "Space",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
  links: [link.ref("contains", "device", { cardinality: "many" })],
})

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("label", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("rpm", "double", { mode: "telemetry" }),
    prop("online", "boolean", { mode: "telemetry" }),
  ],
})

const githubConnector = defineConnector("github", {
  type: "test",
  webhooks: [
    defineWebhook("events")
      .post()
      .json()
      .verify(() => {})
      .handle(() => {}),
  ],
  connect() {
    return { ok: true }
  },
})

const nightlyGithub = defineSchedule("nightly-github").cron("0 2 * * *")

const githubEventsDataset = defineDataset("raw.github.events", {
  description: "Raw GitHub webhook events",
  schema: [col("eventId", "string"), col("action", "string", { nullable: true })],
})

const auditLogDataset = defineDataset("raw.audit.logs", {
  description: "Audit log events waiting for first import",
  schema: [col("eventId", "string"), col("actor", "string", { nullable: true })],
})

const cleanGithubEventsDataset = defineDataset("clean.github.events", {
  description: "Clean GitHub event facts",
  schema: [col("eventId", "string"), col("action", "string", { nullable: true })],
})

const githubEventsUpdated = defineSchedule("github-events-updated").on(
  events.dataset(githubEventsDataset).updated()
)

const githubEventsSync = defineSync("sync-github-events", { mode: "append" })
  .when(nightlyGithub)
  .from(githubConnector)
  .read(() => [])
  .intoDataset(githubEventsDataset)

const cleanGithubEventsStep = definePipelineStep("clean-github-events")
  .inputs({ events: githubEventsDataset })
  .output(cleanGithubEventsDataset)
  .sql(
    ({ events }) => `
    select eventId, action
    from ${events}
    where eventId is not null
  `
  )

const githubEventsPipeline = definePipeline("github-events-pipeline")
  .when(githubEventsUpdated)
  .then(cleanGithubEventsStep)

const inspectDeviceStep = defineWorkflowStep("inspect-device")
  .input({ deviceId: "string" })
  .output({ deviceId: "string", healthy: "boolean" })
  .run(({ input }) => ({ deviceId: input.deviceId, healthy: true }))

const deviceUpdated = defineSchedule("device-updated").on(events.object(Device).updated())

// Widen to the base type at the definition site: materializing these builder
// result types against the wide ontology generic is a known TS2589 landmine.
const inspectDeviceWorkflow: WorkflowDefinition = defineWorkflow("inspect-device-workflow")
  .input({ deviceId: "string" })
  .when(deviceUpdated, ({ event }) => ({ deviceId: event.object.primaryId }))
  .then(inspectDeviceStep)

const reviewDeviceHealth = defineIntervention("review-device-health", {
  description: "Review the device health result before downstream work continues.",
})
  .input({ deviceId: "string", healthy: "boolean" })
  .response({
    approved: interventionField("boolean", { required: true }),
    note: interventionField("string", { required: false }),
  })
  .defaults(({ input }) => ({ approved: input.healthy }))

const reviewDeviceHealthWorkflow: WorkflowDefinition = defineWorkflow(
  "review-device-health-workflow"
)
  .input({ deviceId: "string" })
  .then(inspectDeviceStep)
  .then(reviewDeviceHealth)

const setSpeed = defineAction("setSpeed")
  .on(Device)
  .params({ speed: param("double", { nullable: true }) })
  .writeback(async () => {})

const renameDevice = defineAction("renameDevice")
  .on(Device)
  .params({ label: param("string") })
  .edits(({ objects, params, subject }) => {
    objects(Device).byId(subject.primaryId).update({ label: params.label })
  })

const syncDeviceLabel = defineAction("syncDeviceLabel")
  .on(Device)
  .params({ label: param("string") })
  .writeback(async () => ({ externalId: "ext_123" }))
  .edits(({ objects, params, subject }) => {
    objects(Device).byId(subject.primaryId).update({ label: params.label })
  })
  .effects(async () => {})

const createMaintenanceRun = defineAction("createMaintenanceRun")
  .params({ note: param("string") })
  .writeback(async () => {})

const highRpmRule = defineRule("device.high-rpm")
  .on(Device)
  .where((device) => device.p.rpm.gt(1000))

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer() as ReturnType<typeof createServer> & {
      on(event: string, listener: (error: Error) => void): void
    }

    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(port)
      })
    })
  })
}

async function seedPendingReviewIntervention(
  sixb: SixbHost<readonly OntologySource[]>,
  suffix: string
) {
  const workflowRuns = sixb.storage.workflowRuns
  const workflowInterventions = sixb.storage.workflowInterventions
  if (!workflowRuns || !workflowInterventions) {
    throw new Error("Expected workflow run and intervention storage in test runtime.")
  }

  const runId = `workflow-run-waiting-${suffix}`
  const stepNodeRunId = `workflow-node-run-step-${suffix}`
  const interventionNodeRunId = `workflow-node-run-intervention-${suffix}`
  const pendingInterventionId = `workflow-intervention-${suffix}`
  const stepOutput = { deviceId: "fan-1", healthy: true }

  const workflowExecutionId = await createTestWorkflowExecution(sixb.storage.executions, {
    projectId: sixb.id,
    workflowId: "review-device-health-workflow",
    runId,
  })
  await workflowRuns.queue({
    id: runId,
    projectId: sixb.id,
    executionId: workflowExecutionId,
    workflowId: "review-device-health-workflow",
    input: { deviceId: "fan-1" },
    queuedAt: new Date("2026-02-18T09:19:59.000Z"),
  })
  await workflowRuns.start({
    id: runId,
    projectId: sixb.id,
    startedAt: new Date("2026-02-18T09:20:00.000Z"),
  })
  await workflowRuns.nodes.start({
    id: stepNodeRunId,
    projectId: sixb.id,
    workflowRunId: runId,
    workflowId: "review-device-health-workflow",
    nodeIndex: 0,
    nodeType: "step",
    nodeId: "inspect-device",
    nodeKey: "inspectDevice",
    input: { deviceId: "fan-1" },
    startedAt: new Date("2026-02-18T09:20:01.000Z"),
  })
  await workflowRuns.nodes.finish({
    id: stepNodeRunId,
    projectId: sixb.id,
    status: "succeeded",
    finishedAt: new Date("2026-02-18T09:20:02.000Z"),
    output: stepOutput,
  })
  await workflowRuns.nodes.start({
    id: interventionNodeRunId,
    projectId: sixb.id,
    workflowRunId: runId,
    workflowId: "review-device-health-workflow",
    nodeIndex: 1,
    nodeType: "intervention",
    nodeId: "review-device-health",
    nodeKey: "reviewDeviceHealth",
    input: stepOutput,
    startedAt: new Date("2026-02-18T09:20:03.000Z"),
  })
  await workflowRuns.nodes.wait({
    id: interventionNodeRunId,
    projectId: sixb.id,
    waitingAt: new Date("2026-02-18T09:20:04.000Z"),
  })
  await workflowRuns.wait({
    id: runId,
    projectId: sixb.id,
    waitingAt: new Date("2026-02-18T09:20:04.000Z"),
  })

  return await workflowInterventions.create({
    id: pendingInterventionId,
    projectId: sixb.id,
    workflowId: "review-device-health-workflow",
    workflowRunId: runId,
    nodeRunId: interventionNodeRunId,
    nodeIndex: 1,
    nodeId: "review-device-health",
    nodeKey: "reviewDeviceHealth",
    interventionId: "review-device-health",
    input: stepOutput,
    defaultResponse: { approved: true },
    requestedAt: new Date("2026-02-18T09:20:04.000Z"),
  })
}

describe("SixbServer HTTP contract", () => {
  async function withHttpContractServer(
    run: (context: {
      baseUrl: string
      events: DomainEventLog
      sixb: SixbHost<readonly OntologySource[]>
    }) => Promise<void>
  ): Promise<void> {
    const tempRoot = await mkdtemp(join(tmpdir(), "sixb-http-contract-"))

    const lakeStorage = new InMemoryLakeStorage()
    const storage: Storage = new SqliteStorage()
    const sixb = createSixbInstance<readonly OntologySource[]>({
      id: "contract-project",
      ontology: [Space, Device],
      actions: [setSpeed, renameDevice, syncDeviceLabel, createMaintenanceRun],
      broker: new InMemoryBroker(),
      storage,
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      connectors: [githubConnector],
      schedules: [nightlyGithub, deviceUpdated, githubEventsUpdated],
      datasets: [githubEventsDataset, auditLogDataset, cleanGithubEventsDataset],
      syncs: [githubEventsSync],
      pipelines: [githubEventsPipeline],
      workflows: [inspectDeviceWorkflow, reviewDeviceHealthWorkflow],
      rules: [highRpmRule],
    })

    const setup = createTestSixb(sixb)
    await setup.objects.upsert("space", { id: "system", name: "System" })
    await setup.objects.upsert("device", { id: "fan-1", label: "Fan 1" })
    await setup.objects.upsertLink("space", "system", "contains", {
      targetTypeId: "device",
      targetId: "fan-1",
    })

    await setup.objects.appendTelemetry("device", [
      {
        id: "fan-1",
        properties: { rpm: 1100 },
        at: new Date("2026-02-18T10:00:00.000Z"),
      },
      {
        id: "fan-1",
        properties: { rpm: 1200, online: true },
        at: new Date("2026-02-18T10:00:10.000Z"),
      },
    ])

    await sixb.storage.rules!.applyTriggered({
      id: "rule-state-event-1",
      cursor: "1",
      schemaVersion: 1,
      projectId: "contract-project",
      type: "rule.triggered",
      topic: "rules",
      partitionKey: "device.high-rpm:device:fan-1",
      payload: {
        ruleId: "device.high-rpm",
        subject: {
          kind: "object",
          objectTypeId: "device",
          primaryId: "fan-1",
        },
        triggeredAt: "2026-02-18T10:00:10.000Z",
      },
      occurredAt: "2026-02-18T10:00:10.000Z",
    })

    await lakeStorage.createDataset(githubEventsDataset)
    const write = await lakeStorage.beginWrite({
      dataset: githubEventsDataset,
      mode: "append",
      producer: {
        kind: "sync",
        id: "sync-github-events",
        runId: "run-previous",
      },
    })
    await write.writeRows([
      { eventId: "evt-1", action: "opened" },
      { eventId: "evt-2", action: null },
      { eventId: "evt-3", action: "closed" },
    ])
    const committedVersion = await write.commit({ commitMessage: "previous import" })

    await sixb.storage.syncRuns!.start({
      id: "run-previous",
      projectId: "contract-project",
      syncId: "sync-github-events",
      datasetId: "raw.github.events",
      mode: "append",
      startedAt: new Date("2026-02-18T09:00:00.000Z"),
      commitMessage: "previous import",
    })
    await sixb.storage.syncRuns!.finish({
      id: "run-previous",
      projectId: "contract-project",
      status: "succeeded",
      finishedAt: new Date("2026-02-18T09:00:03.000Z"),
      rowsRead: 3,
      output: {
        datasetId: "raw.github.events",
        versionId: committedVersion.versionId,
      },
      checkpoint: { cursor: "secret-sync-cursor" },
    })

    await sixb.storage.pipelineRuns!.start({
      id: "pipeline-run-previous",
      projectId: "contract-project",
      pipelineId: "github-events-pipeline",
      startedAt: new Date("2026-02-18T09:05:00.000Z"),
    })
    await sixb.storage.pipelineRuns!.startStep({
      id: "pipeline-step-run-previous",
      projectId: "contract-project",
      pipelineRunId: "pipeline-run-previous",
      pipelineId: "github-events-pipeline",
      stepId: "clean-github-events",
      datasetId: "clean.github.events",
      mode: "snapshot",
      startedAt: new Date("2026-02-18T09:05:00.500Z"),
      inputs: [{ datasetId: "raw.github.events", versionId: "ver_previous" }],
    })
    await sixb.storage.pipelineRuns!.finishStep({
      id: "pipeline-step-run-previous",
      projectId: "contract-project",
      status: "succeeded",
      finishedAt: new Date("2026-02-18T09:05:01.000Z"),
      output: {
        datasetId: "clean.github.events",
        versionId: "ver_pipeline_previous",
      },
      rowsWritten: 3,
    })
    await sixb.storage.pipelineRuns!.finish({
      id: "pipeline-run-previous",
      projectId: "contract-project",
      status: "succeeded",
      finishedAt: new Date("2026-02-18T09:05:02.000Z"),
      output: {
        datasetId: "clean.github.events",
        versionId: "ver_pipeline_previous",
      },
    })

    const previousWorkflowExecutionId = await createTestWorkflowExecution(sixb.storage.executions, {
      projectId: "contract-project",
      workflowId: "inspect-device-workflow",
      runId: "workflow-run-previous",
    })
    await sixb.storage.workflowRuns!.queue({
      id: "workflow-run-previous",
      projectId: "contract-project",
      executionId: previousWorkflowExecutionId,
      workflowId: "inspect-device-workflow",
      input: { deviceId: "fan-1" },
      queuedAt: new Date("2026-02-18T09:06:59.000Z"),
    })
    await sixb.storage.workflowRuns!.start({
      id: "workflow-run-previous",
      projectId: "contract-project",
      startedAt: new Date("2026-02-18T09:07:00.000Z"),
    })
    await sixb.storage.workflowRuns!.nodes.start({
      id: "workflow-node-run-previous",
      projectId: "contract-project",
      workflowRunId: "workflow-run-previous",
      workflowId: "inspect-device-workflow",
      nodeIndex: 0,
      nodeType: "step",
      nodeId: "inspect-device",
      nodeKey: "inspectDevice",
      input: { deviceId: "fan-1" },
      startedAt: new Date("2026-02-18T09:07:00.500Z"),
    })
    await sixb.storage.workflowRuns!.nodes.finish({
      id: "workflow-node-run-previous",
      projectId: "contract-project",
      status: "succeeded",
      finishedAt: new Date("2026-02-18T09:07:01.000Z"),
      output: { deviceId: "fan-1", healthy: true },
    })
    await sixb.storage.workflowRuns!.finish({
      id: "workflow-run-previous",
      projectId: "contract-project",
      status: "succeeded",
      output: { deviceId: "fan-1", healthy: true },
      finishedAt: new Date("2026-02-18T09:07:02.000Z"),
    })

    await sixb.storage.webhookRuns!.start({
      id: "webhook-run-previous",
      projectId: "contract-project",
      connectorId: "github",
      webhookId: "events",
      method: "POST",
      route: "/api/webhooks/github/events",
      startedAt: new Date("2026-02-18T09:10:00.000Z"),
    })
    await sixb.storage.webhookRuns!.finish({
      id: "webhook-run-previous",
      projectId: "contract-project",
      status: "succeeded",
      finishedAt: new Date("2026-02-18T09:10:01.000Z"),
      requestBodyBytes: 18,
      responseStatus: 202,
    })

    await sixb.storage.actionRuns!.queue({
      id: "act_audit_previous",
      projectId: "contract-project",
      actionId: "syncDeviceLabel",
      subject: {
        kind: "object",
        objectTypeId: "device",
        primaryId: "fan-1",
      },
      params: { label: "Fan 1 audited" },
      idempotencyKey: "action:contract-project:act_audit_previous",
      queuedAt: new Date("2026-02-18T09:12:00.000Z"),
    })
    await sixb.storage.actionRuns!.start({
      id: "act_audit_previous",
      projectId: "contract-project",
      startedAt: new Date("2026-02-18T09:12:01.000Z"),
      phase: "validation",
    })
    await sixb.storage.actionRuns!.recordWriteback({
      id: "act_audit_previous",
      projectId: "contract-project",
      status: "succeeded",
      completedAt: new Date("2026-02-18T09:12:02.000Z"),
      result: { externalId: "ext_123" },
    })
    await sixb.storage.actionRuns!.recordEffects({
      id: "act_audit_previous",
      projectId: "contract-project",
      status: "failed",
      completedAt: new Date("2026-02-18T09:12:04.000Z"),
      error: {
        name: "NotificationError",
        message: "Notification failed",
        phase: "effects",
      },
    })
    await sixb.storage.actionRuns!.finish({
      id: "act_audit_previous",
      projectId: "contract-project",
      status: "succeeded",
      finishedAt: new Date("2026-02-18T09:12:05.000Z"),
      phase: "effects",
    })

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`

    const server = new SixbServer({
      host: sixb,
      hostname: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
    })

    await server.start()

    try {
      await run({ baseUrl, events: sixb.events, sixb })
    } finally {
      await server.stop()
      await rm(tempRoot, { recursive: true, force: true })
    }
  }

  test("serves documented read endpoints", async () => {
    await withHttpContractServer(async ({ baseUrl }) => {
      const projectResponse = await fetch(`${baseUrl}/api/project`)
      expect(projectResponse.status).toBe(200)
      expect(await projectResponse.json()).toEqual({ id: "contract-project" })

      const statusResponse = await fetch(`${baseUrl}/api/status`)
      expect(statusResponse.status).toBe(200)
      expect(await statusResponse.json()).toMatchObject({
        status: "ok",
        objectTypes: 2,
        maintenance: {
          running: false,
          consecutiveFailures: 0,
          outbox: { pendingCount: 0 },
        },
      })

      const healthResponse = await fetch(`${baseUrl}/health`)
      expect(healthResponse.status).toBe(200)
      expect(await healthResponse.json()).toEqual({ status: "ok" })

      const readinessResponse = await fetch(`${baseUrl}/ready`)
      expect(readinessResponse.status).toBe(200)
      expect(await readinessResponse.json()).toMatchObject({
        status: "ready",
        storage: { reachable: true, schemaValid: true },
      })

      const connectorsResponse = await fetch(`${baseUrl}/api/connectors`)
      expect(connectorsResponse.status).toBe(200)
      expect(await connectorsResponse.json()).toEqual([
        {
          id: "github",
          type: "test",
          syncIds: ["sync-github-events"],
          webhooks: [
            {
              id: "events",
              method: "POST",
              route: "/api/webhooks/github/events",
              bodyFormat: "json",
              hasVerify: true,
              hasIdempotency: false,
            },
          ],
        },
      ])

      const connectorResponse = await fetch(`${baseUrl}/api/connectors/github`)
      expect(connectorResponse.status).toBe(200)
      expect(await connectorResponse.json()).toEqual({
        id: "github",
        type: "test",
        syncIds: ["sync-github-events"],
        webhooks: [
          {
            id: "events",
            method: "POST",
            route: "/api/webhooks/github/events",
            bodyFormat: "json",
            hasVerify: true,
            hasIdempotency: false,
          },
        ],
      })

      const missingConnectorResponse = await fetch(`${baseUrl}/api/connectors/missing`)
      expect(missingConnectorResponse.status).toBe(404)
      expect(await missingConnectorResponse.json()).toEqual({ error: "Connector not found" })

      const webhookRunsResponse = await fetch(
        `${baseUrl}/api/webhook-runs?connectorId=github&webhookId=events&limit=5`
      )
      expect(webhookRunsResponse.status).toBe(200)
      expect(await webhookRunsResponse.json()).toMatchObject({
        total: 1,
        hasMore: false,
        runs: [
          {
            id: "webhook-run-previous",
            connectorId: "github",
            webhookId: "events",
            method: "POST",
            route: "/api/webhooks/github/events",
            status: "succeeded",
            requestBodyBytes: 18,
            responseStatus: 202,
          },
        ],
      })

      const datasetsResponse = await fetch(`${baseUrl}/api/datasets`)
      expect(datasetsResponse.status).toBe(200)
      const datasets = (await datasetsResponse.json()) as Array<{
        id: string
        kind: string
        materialized: boolean
        syncIds: string[]
        sourcePipelineIds: string[]
        targetPipelineIds: string[]
        projectionIds: string[]
        latestVersion: { versionId: string; mode: string; rowCount?: number } | null
      }>
      const githubDataset = datasets.find((dataset) => dataset.id === "raw.github.events")
      const auditDataset = datasets.find((dataset) => dataset.id === "raw.audit.logs")
      expect(githubDataset).toMatchObject({
        kind: "dataset",
        id: "raw.github.events",
        materialized: true,
        syncIds: ["sync-github-events"],
        sourcePipelineIds: ["github-events-pipeline"],
        targetPipelineIds: [],
        projectionIds: [],
        latestVersion: expect.objectContaining({
          versionId: expect.any(String),
          mode: "append",
          rowCount: 3,
        }),
      })
      expect(auditDataset).toMatchObject({
        kind: "dataset",
        id: "raw.audit.logs",
        materialized: false,
        syncIds: [],
        latestVersion: null,
      })

      const datasetResponse = await fetch(`${baseUrl}/api/datasets/raw.github.events`)
      expect(datasetResponse.status).toBe(200)
      expect(await datasetResponse.json()).toMatchObject({
        id: "raw.github.events",
        description: "Raw GitHub webhook events",
        schema: {
          columns: [
            { name: "eventId", type: "string" },
            { name: "action", type: "string", nullable: true },
          ],
        },
      })

      const missingDatasetResponse = await fetch(`${baseUrl}/api/datasets/missing`)
      expect(missingDatasetResponse.status).toBe(404)
      expect(await missingDatasetResponse.json()).toEqual({ error: "Dataset not found" })

      const versionsResponse = await fetch(
        `${baseUrl}/api/datasets/raw.github.events/versions?limit=5`
      )
      expect(versionsResponse.status).toBe(200)
      const versionsBody = (await versionsResponse.json()) as {
        count: number
        versions: Array<{ versionId: string; rowCount?: number; createdAt: string }>
      }
      expect(versionsBody.count).toBe(1)
      expect(versionsBody.versions[0]).toEqual(
        expect.objectContaining({
          versionId: expect.any(String),
          rowCount: 3,
        })
      )

      const versionId = versionsBody.versions[0]!.versionId
      const versionResponse = await fetch(
        `${baseUrl}/api/datasets/raw.github.events/versions/${versionId}`
      )
      expect(versionResponse.status).toBe(200)
      expect(await versionResponse.json()).toMatchObject({
        datasetId: "raw.github.events",
        versionId,
        rowCount: 3,
      })

      const rowsResponse = await fetch(
        `${baseUrl}/api/datasets/raw.github.events/rows?columns=eventId&limit=2&offset=1`
      )
      expect(rowsResponse.status).toBe(200)
      expect(await rowsResponse.json()).toMatchObject({
        datasetId: "raw.github.events",
        versionId,
        columns: ["eventId"],
        count: 2,
        limit: 2,
        offset: 1,
        total: 3,
        hasMore: false,
        rows: [{ eventId: "evt-2" }, { eventId: "evt-3" }],
      })

      const uncommittedRowsResponse = await fetch(`${baseUrl}/api/datasets/raw.audit.logs/rows`)
      expect(uncommittedRowsResponse.status).toBe(404)
      expect(await uncommittedRowsResponse.json()).toEqual({
        error: "Dataset version not found",
      })

      const invalidRowsResponse = await fetch(
        `${baseUrl}/api/datasets/raw.github.events/rows?columns=missing`
      )
      expect(invalidRowsResponse.status).toBe(400)
      expect((await invalidRowsResponse.json()) as { error: string }).toEqual({
        error: `Dataset 'raw.github.events' does not have column 'missing' at version '${versionId}'`,
      })

      const invalidOffsetResponse = await fetch(
        `${baseUrl}/api/datasets/raw.github.events/rows?offset=-1`
      )
      expect(invalidOffsetResponse.status).toBe(400)
      expect(await invalidOffsetResponse.json()).toEqual({
        error: "Offset must be greater than or equal to 0",
      })

      const syncsResponse = await fetch(`${baseUrl}/api/syncs`)
      expect(syncsResponse.status).toBe(200)
      const syncs = (await syncsResponse.json()) as Array<{
        id: string
        mode: string
        connector: { id: string; type: string }
        target: { kind: string; dataset: { id: string; schema: { columns: unknown[] } } }
        triggers: Array<{ type: string; scheduleId?: string }>
        latestRun: { id: string; status: string; rowsRead?: number } | null
      }>
      expect(syncs).toEqual([
        expect.objectContaining({
          id: "sync-github-events",
          mode: "append",
          connector: { id: "github", type: "test" },
          target: expect.objectContaining({
            kind: "dataset",
            dataset: expect.objectContaining({
              id: "raw.github.events",
              schema: {
                columns: [
                  { name: "eventId", type: "string" },
                  { name: "action", type: "string", nullable: true },
                ],
              },
            }),
          }),
          triggers: [{ type: "schedule", scheduleId: "nightly-github" }],
          latestRun: expect.objectContaining({
            id: "run-previous",
            status: "succeeded",
            rowsRead: 3,
          }),
        }),
      ])
      expect(syncs[0]?.latestRun).not.toHaveProperty("checkpoint")
      expect(syncs[0]?.latestRun).not.toHaveProperty("metadata")

      const syncResponse = await fetch(`${baseUrl}/api/syncs/sync-github-events`)
      expect(syncResponse.status).toBe(200)
      expect(await syncResponse.json()).toMatchObject({
        id: "sync-github-events",
        target: {
          dataset: {
            id: "raw.github.events",
          },
        },
      })

      const missingSyncResponse = await fetch(`${baseUrl}/api/syncs/missing`)
      expect(missingSyncResponse.status).toBe(404)
      expect(await missingSyncResponse.json()).toEqual({ error: "Sync not found" })

      const syncRunsResponse = await fetch(
        `${baseUrl}/api/sync-runs?syncId=sync-github-events&limit=5`
      )
      expect(syncRunsResponse.status).toBe(200)
      const syncRunsBody = (await syncRunsResponse.json()) as {
        runs: Array<Record<string, unknown>>
      }
      expect(syncRunsBody).toMatchObject({
        total: 1,
        hasMore: false,
        runs: [
          {
            id: "run-previous",
            syncId: "sync-github-events",
            datasetId: "raw.github.events",
            mode: "append",
            status: "succeeded",
            rowsRead: 3,
            output: {
              datasetId: "raw.github.events",
              versionId: versionId,
            },
          },
        ],
      })
      expect(syncRunsBody.runs[0]).not.toHaveProperty("checkpoint")
      expect(syncRunsBody.runs[0]).not.toHaveProperty("metadata")

      const pipelinesResponse = await fetch(`${baseUrl}/api/pipelines`)
      expect(pipelinesResponse.status).toBe(200)
      const pipelines = (await pipelinesResponse.json()) as Array<{
        id: string
        triggers: Array<{ type: string; scheduleId?: string }>
        graph: {
          nodes: Array<{
            step: {
              id: string
              mode: string
              executor: { kind: string; dialect?: string }
              inputs: Array<{ name: string; dataset: { id: string } }>
              output: { id: string }
            }
          }>
        }
        latestRun: { id: string; status: string; output?: { datasetId: string } } | null
      }>
      expect(pipelines).toEqual([
        expect.objectContaining({
          id: "github-events-pipeline",
          triggers: [{ type: "schedule", scheduleId: "github-events-updated" }],
          graph: {
            kind: "sequence",
            nodes: [
              {
                kind: "step",
                step: expect.objectContaining({
                  id: "clean-github-events",
                  mode: "snapshot",
                  executor: { kind: "sql", dialect: "duckdb" },
                  inputs: [
                    {
                      name: "events",
                      dataset: expect.objectContaining({ id: "raw.github.events" }),
                    },
                  ],
                  output: expect.objectContaining({ id: "clean.github.events" }),
                }),
              },
            ],
          },
          latestRun: expect.objectContaining({
            id: "pipeline-run-previous",
            status: "succeeded",
            output: {
              datasetId: "clean.github.events",
              versionId: "ver_pipeline_previous",
            },
          }),
        }),
      ])

      const pipelineResponse = await fetch(`${baseUrl}/api/pipelines/github-events-pipeline`)
      expect(pipelineResponse.status).toBe(200)
      expect(await pipelineResponse.json()).toMatchObject({
        id: "github-events-pipeline",
        graph: {
          nodes: [
            {
              step: {
                id: "clean-github-events",
                executor: { kind: "sql", dialect: "duckdb" },
              },
            },
          ],
        },
      })

      const missingPipelineResponse = await fetch(`${baseUrl}/api/pipelines/missing`)
      expect(missingPipelineResponse.status).toBe(404)
      expect(await missingPipelineResponse.json()).toEqual({ error: "Pipeline not found" })

      const pipelineRunsResponse = await fetch(
        `${baseUrl}/api/pipeline-runs?pipelineId=github-events-pipeline&limit=5`
      )
      expect(pipelineRunsResponse.status).toBe(200)
      expect(await pipelineRunsResponse.json()).toMatchObject({
        total: 1,
        hasMore: false,
        runs: [
          {
            id: "pipeline-run-previous",
            pipelineId: "github-events-pipeline",
            status: "succeeded",
            output: {
              datasetId: "clean.github.events",
              versionId: "ver_pipeline_previous",
            },
          },
        ],
      })

      const pipelineRunResponse = await fetch(`${baseUrl}/api/pipeline-runs/pipeline-run-previous`)
      expect(pipelineRunResponse.status).toBe(200)
      expect(await pipelineRunResponse.json()).toMatchObject({
        run: {
          id: "pipeline-run-previous",
          pipelineId: "github-events-pipeline",
          status: "succeeded",
        },
        steps: [
          {
            id: "pipeline-step-run-previous",
            pipelineRunId: "pipeline-run-previous",
            stepId: "clean-github-events",
            datasetId: "clean.github.events",
            mode: "snapshot",
            status: "succeeded",
            inputs: [{ datasetId: "raw.github.events", versionId: "ver_previous" }],
            output: {
              datasetId: "clean.github.events",
              versionId: "ver_pipeline_previous",
            },
            rowsWritten: 3,
          },
        ],
      })

      const workflowsResponse = await fetch(`${baseUrl}/api/workflows`)
      expect(workflowsResponse.status).toBe(200)
      const workflows = (await workflowsResponse.json()) as Array<{
        id: string
        nodes: readonly unknown[]
      }>
      expect(workflows).toHaveLength(2)
      expect(workflows.find((workflow) => workflow.id === "inspect-device-workflow")).toMatchObject(
        {
          id: "inspect-device-workflow",
          input: { deviceId: "string" },
          triggers: [{ type: "schedule", scheduleId: "device-updated" }],
          nodes: [
            {
              type: "step",
              id: "inspect-device",
              key: "inspectDevice",
              input: { deviceId: "string" },
              output: { deviceId: "string", healthy: "boolean" },
            },
          ],
          latestRun: expect.objectContaining({
            id: "workflow-run-previous",
            status: "succeeded",
          }),
        }
      )
      expect(
        workflows.find((workflow) => workflow.id === "review-device-health-workflow")
      ).toMatchObject({
        id: "review-device-health-workflow",
        nodes: [
          {
            type: "step",
            id: "inspect-device",
            key: "inspectDevice",
          },
          {
            type: "intervention",
            id: "review-device-health",
            key: "reviewDeviceHealth",
            input: { deviceId: "string", healthy: "boolean" },
            response: {
              approved: { schema: "boolean", required: true },
              note: { schema: "string", required: false },
            },
            description: "Review the device health result before downstream work continues.",
          },
        ],
      })

      const workflowResponse = await fetch(`${baseUrl}/api/workflows/inspect-device-workflow`)
      expect(workflowResponse.status).toBe(200)
      expect(await workflowResponse.json()).toMatchObject({
        id: "inspect-device-workflow",
        nodes: [{ type: "step", id: "inspect-device", key: "inspectDevice" }],
      })

      const missingWorkflowResponse = await fetch(`${baseUrl}/api/workflows/missing`)
      expect(missingWorkflowResponse.status).toBe(404)
      expect(await missingWorkflowResponse.json()).toEqual({ error: "Workflow not found" })

      const workflowRunsResponse = await fetch(
        `${baseUrl}/api/workflow-runs?workflowId=inspect-device-workflow&limit=5`
      )
      expect(workflowRunsResponse.status).toBe(200)
      const workflowRunList = (await workflowRunsResponse.json()) as {
        runs: Array<Record<string, unknown>>
      }
      expect(workflowRunList).toMatchObject({
        total: 1,
        hasMore: false,
        runs: [
          {
            id: "workflow-run-previous",
            workflowId: "inspect-device-workflow",
            status: "succeeded",
          },
        ],
      })
      expect(workflowRunList.runs[0]).not.toHaveProperty("input")
      expect(workflowRunList.runs[0]).not.toHaveProperty("output")

      const workflowRunResponse = await fetch(`${baseUrl}/api/workflow-runs/workflow-run-previous`)
      expect(workflowRunResponse.status).toBe(200)
      expect(await workflowRunResponse.json()).toMatchObject({
        run: {
          id: "workflow-run-previous",
          workflowId: "inspect-device-workflow",
          status: "succeeded",
          input: { deviceId: "fan-1" },
          output: { deviceId: "fan-1", healthy: true },
        },
        nodes: [
          {
            id: "workflow-node-run-previous",
            workflowRunId: "workflow-run-previous",
            nodeId: "inspect-device",
            nodeKey: "inspectDevice",
            status: "succeeded",
            input: { deviceId: "fan-1" },
            output: { deviceId: "fan-1", healthy: true },
          },
        ],
      })

      const rulesResponse = await fetch(`${baseUrl}/api/rules`)
      expect(rulesResponse.status).toBe(200)
      expect(await rulesResponse.json()).toEqual([
        {
          kind: "rule",
          id: "device.high-rpm",
          subject: {
            kind: "object",
            objectTypeId: "device",
          },
          predicate: {
            kind: "property",
            propertyId: "rpm",
            op: "gt",
            value: 1000,
          },
          dependencies: [
            {
              type: "object.created",
              objectTypeId: "device",
            },
            {
              type: "object.updated",
              objectTypeId: "device",
            },
            {
              type: "object.deleted",
              objectTypeId: "device",
            },
          ],
        },
      ])

      const ruleResponse = await fetch(`${baseUrl}/api/rules/device.high-rpm`)
      expect(ruleResponse.status).toBe(200)
      expect(await ruleResponse.json()).toMatchObject({
        id: "device.high-rpm",
        subject: {
          kind: "object",
          objectTypeId: "device",
        },
      })

      const missingRuleResponse = await fetch(`${baseUrl}/api/rules/missing`)
      expect(missingRuleResponse.status).toBe(404)
      expect(await missingRuleResponse.json()).toEqual({ error: "Rule not found" })

      const ruleStatesResponse = await fetch(
        `${baseUrl}/api/rule-states?ruleId=device.high-rpm&limit=5`
      )
      expect(ruleStatesResponse.status).toBe(200)
      expect(await ruleStatesResponse.json()).toEqual({
        states: [
          {
            projectId: "contract-project",
            ruleId: "device.high-rpm",
            subject: {
              kind: "object",
              objectTypeId: "device",
              primaryId: "fan-1",
            },
            triggeredAt: "2026-02-18T10:00:10.000Z",
          },
        ],
        hasMore: false,
        total: 1,
      })

      const objectTypesResponse = await fetch(`${baseUrl}/api/object-types`)
      expect(objectTypesResponse.status).toBe(200)
      const objectTypes = (await objectTypesResponse.json()) as Array<{ id: string }>
      expect(objectTypes.map((objectType) => objectType.id)).toEqual(["space", "device"])

      const objectTypeResponse = await fetch(`${baseUrl}/api/object-types/device`)
      expect(objectTypeResponse.status).toBe(200)
      const objectType = (await objectTypeResponse.json()) as {
        id: string
        actions: Array<{ id: string; params: Array<{ id: string; nullable?: boolean }> }>
      }
      expect(objectType.id).toBe("device")
      expect(objectType.actions[0]).toMatchObject({
        id: "setSpeed",
        params: [{ id: "speed", nullable: true }],
      })

      const actionsResponse = await fetch(`${baseUrl}/api/actions`)
      expect(actionsResponse.status).toBe(200)
      expect(await actionsResponse.json()).toEqual([
        {
          id: "setSpeed",
          name: "setSpeed",
          objectTypeId: "device",
          params: [
            {
              id: "speed",
              name: "speed",
              schema: "double",
              required: true,
              nullable: true,
            },
          ],
          phases: {
            validate: false,
            writeback: true,
            edits: false,
            effects: false,
          },
        },
        {
          id: "renameDevice",
          name: "renameDevice",
          objectTypeId: "device",
          params: [
            {
              id: "label",
              name: "label",
              schema: "string",
              required: true,
            },
          ],
          phases: {
            validate: false,
            writeback: false,
            edits: true,
            effects: false,
          },
        },
        {
          id: "syncDeviceLabel",
          name: "syncDeviceLabel",
          objectTypeId: "device",
          params: [
            {
              id: "label",
              name: "label",
              schema: "string",
              required: true,
            },
          ],
          phases: {
            validate: false,
            writeback: true,
            edits: true,
            effects: true,
          },
        },
        {
          id: "createMaintenanceRun",
          name: "createMaintenanceRun",
          params: [
            {
              id: "note",
              name: "note",
              schema: "string",
              required: true,
            },
          ],
          phases: {
            validate: false,
            writeback: true,
            edits: false,
            effects: false,
          },
        },
      ])

      const actionResponse = await fetch(`${baseUrl}/api/actions/createMaintenanceRun`)
      expect(actionResponse.status).toBe(200)
      expect(await actionResponse.json()).toEqual({
        id: "createMaintenanceRun",
        name: "createMaintenanceRun",
        params: [
          {
            id: "note",
            name: "note",
            schema: "string",
            required: true,
          },
        ],
        phases: {
          validate: false,
          writeback: true,
          edits: false,
          effects: false,
        },
      })

      const missingActionResponse = await fetch(`${baseUrl}/api/actions/missing`)
      expect(missingActionResponse.status).toBe(404)
      expect(await missingActionResponse.json()).toEqual({ error: "Action not found" })

      const objectsResponse = await fetch(`${baseUrl}/api/objects?objectTypeId=device`)
      expect(objectsResponse.status).toBe(200)
      const objectsBody = (await objectsResponse.json()) as {
        objects: Array<{ primaryId: string; properties: Record<string, unknown> }>
        total: number
      }
      expect(objectsBody.total).toBe(1)
      expect(objectsBody.objects[0]).toMatchObject({
        primaryId: "fan-1",
        properties: {
          label: "Fan 1",
          rpm: 1200,
          online: true,
        },
      })

      const unknownObjectTypeResponse = await fetch(`${baseUrl}/api/objects?objectTypeId=Device`)
      expect(unknownObjectTypeResponse.status).toBe(400)
      expect(await unknownObjectTypeResponse.json()).toEqual({
        error: "Unknown object type 'Device'. Object type IDs are case-sensitive.",
      })

      const emptyObjectTypeResponse = await fetch(`${baseUrl}/api/objects?objectTypeId=`)
      expect(emptyObjectTypeResponse.status).toBe(400)
      expect(await emptyObjectTypeResponse.json()).toEqual({
        error: "Unknown object type ''. Object type IDs are case-sensitive.",
      })

      const invalidObjectListQueries: {
        query: Record<string, string>
        error: string
      }[] = [
        {
          query: { limit: "10abc" },
          error: "Invalid query parameter 'limit': expected an integer between 0 and 1000.",
        },
        {
          query: { limit: "1.5" },
          error: "Invalid query parameter 'limit': expected an integer between 0 and 1000.",
        },
        {
          query: { limit: "-1" },
          error: "Invalid query parameter 'limit': expected an integer between 0 and 1000.",
        },
        {
          query: { limit: "1001" },
          error: "Invalid query parameter 'limit': expected an integer between 0 and 1000.",
        },
        {
          query: { offset: "-1" },
          error: "Invalid query parameter 'offset': expected a non-negative safe integer.",
        },
        {
          query: { offset: "9007199254740992" },
          error: "Invalid query parameter 'offset': expected a non-negative safe integer.",
        },
        {
          query: { orderBy: "name" },
          error:
            "Invalid query parameter 'orderBy': expected one of createdAt, updatedAt, or primaryId.",
        },
        {
          query: { order: "newest" },
          error: "Invalid query parameter 'order': expected 'asc' or 'desc'.",
        },
        {
          query: { createdAfter: "not-a-date" },
          error: "Invalid query parameter 'createdAfter': expected an RFC 3339 timestamp.",
        },
        {
          query: { updatedBefore: "2026-07-12" },
          error: "Invalid query parameter 'updatedBefore': expected an RFC 3339 timestamp.",
        },
        {
          query: {
            createdAfter: "2026-07-13T00:00:00Z",
            createdBefore: "2026-07-12T00:00:00Z",
          },
          error:
            "Invalid query parameter range: 'createdAfter' must be before or equal to 'createdBefore'.",
        },
        {
          query: {
            updatedAfter: "2026-07-13T00:00:00Z",
            updatedBefore: "2026-07-12T00:00:00Z",
          },
          error:
            "Invalid query parameter range: 'updatedAfter' must be before or equal to 'updatedBefore'.",
        },
      ]

      for (const invalid of invalidObjectListQueries) {
        const search = new URLSearchParams(invalid.query)
        const response = await fetch(`${baseUrl}/api/objects?${search}`)
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: invalid.error })
      }

      const zeroLimitResponse = await fetch(
        `${baseUrl}/api/objects?objectTypeId=device&limit=0&offset=0`
      )
      expect(zeroLimitResponse.status).toBe(200)
      expect(await zeroLimitResponse.json()).toMatchObject({
        objects: [],
        hasMore: true,
        total: 1,
      })

      const validObjectListSearch = new URLSearchParams({
        objectTypeId: "device",
        limit: "1000",
        offset: "0",
        createdAfter: "1970-01-01T00:00:00Z",
        updatedBefore: "2100-01-01T00:00:00+04:00",
      })
      const validObjectListResponse = await fetch(`${baseUrl}/api/objects?${validObjectListSearch}`)
      expect(validObjectListResponse.status).toBe(200)

      const queryObjectsResponse = await fetch(`${baseUrl}/api/objects/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            kind: "limit",
            limit: 5,
            input: { kind: "start", objectTypeId: "device" },
          },
        }),
      })
      expect(queryObjectsResponse.status).toBe(200)
      const queryObjectsBody = (await queryObjectsResponse.json()) as {
        objects: Array<{ primaryId: string; properties: Record<string, unknown> }>
        plan: { mode: string; providerIssues: unknown[] }
      }
      expect(queryObjectsBody.plan.mode).toBe("pushdown")
      expect(queryObjectsBody.plan.providerIssues).toEqual([])
      expect(queryObjectsBody.objects).toEqual([
        expect.objectContaining({
          primaryId: "fan-1",
          properties: expect.objectContaining({
            label: "Fan 1",
            rpm: 1200,
          }),
        }),
      ])

      const queryObjectsWithoutTotalResponse = await fetch(`${baseUrl}/api/objects/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          includeTotal: false,
          query: {
            kind: "limit",
            limit: 5,
            input: { kind: "start", objectTypeId: "device" },
          },
        }),
      })
      expect(queryObjectsWithoutTotalResponse.status).toBe(200)
      const queryObjectsWithoutTotalBody =
        (await queryObjectsWithoutTotalResponse.json()) as Record<string, unknown>
      expect(Object.hasOwn(queryObjectsWithoutTotalBody, "total")).toBe(false)
      expect(queryObjectsWithoutTotalBody.hasMore).toBe(false)

      const countObjectsResponse = await fetch(`${baseUrl}/api/objects/query/count`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            kind: "limit",
            limit: 0,
            input: { kind: "start", objectTypeId: "device" },
          },
        }),
      })
      expect(countObjectsResponse.status).toBe(200)
      expect(await countObjectsResponse.json()).toMatchObject({
        count: 1,
        plan: { mode: "pushdown", providerIssues: [] },
      })

      const existsObjectsResponse = await fetch(`${baseUrl}/api/objects/query/exists`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            kind: "limit",
            limit: 0,
            input: { kind: "start", objectTypeId: "device" },
          },
        }),
      })
      expect(existsObjectsResponse.status).toBe(200)
      expect(await existsObjectsResponse.json()).toMatchObject({
        exists: true,
        plan: { mode: "pushdown", providerIssues: [] },
      })

      const facetObjectsResponse = await fetch(`${baseUrl}/api/objects/query/facets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            kind: "limit",
            limit: 0,
            input: { kind: "start", objectTypeId: "device" },
          },
          facets: [{ propertyId: "label", limit: 10 }],
        }),
      })
      expect(facetObjectsResponse.status).toBe(200)
      expect(await facetObjectsResponse.json()).toMatchObject({
        facets: [
          {
            propertyId: "label",
            buckets: [{ value: "Fan 1", count: 1 }],
          },
        ],
        plan: { mode: "pushdown", providerIssues: [] },
      })

      const invalidQueryObjectsResponse = await fetch(`${baseUrl}/api/objects/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            kind: "limit",
            limit: 5,
            input: { kind: "start", objectTypeId: "missing" },
          },
        }),
      })
      expect(invalidQueryObjectsResponse.status).toBe(400)
      expect(await invalidQueryObjectsResponse.json()).toMatchObject({
        issues: [
          {
            path: "$.input",
            code: "unknown_object_type",
            message: "Unknown object type 'missing'. Object type IDs are case-sensitive.",
          },
        ],
      })

      const invalidPageTokenResponse = await fetch(`${baseUrl}/api/objects/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            kind: "page",
            pageSize: 5,
            pageToken: "not-a-token",
            input: { kind: "start", objectTypeId: "device" },
          },
        }),
      })
      expect(invalidPageTokenResponse.status).toBe(400)
      expect(await invalidPageTokenResponse.json()).toMatchObject({
        issues: [
          {
            path: "$.pageToken",
            code: "invalid_page_token",
          },
        ],
      })

      const objectResponse = await fetch(`${baseUrl}/api/objects/device/fan-1`)
      expect(objectResponse.status).toBe(200)
      const objectBody = (await objectResponse.json()) as {
        primaryId: string
        properties: Record<string, unknown>
      }
      expect(objectBody.primaryId).toBe("fan-1")
      expect(objectBody.properties.rpm).toBe(1200)

      const linksResponse = await fetch(`${baseUrl}/api/objects/space/system/links`)
      expect(linksResponse.status).toBe(200)
      const links = (await linksResponse.json()) as Array<{
        sourceTypeId: string
        sourceId: string
        linkId: string
        targetTypeId: string
        targetId: string
      }>
      expect(links).toEqual([
        expect.objectContaining({
          sourceTypeId: "space",
          sourceId: "system",
          linkId: "contains",
          targetTypeId: "device",
          targetId: "fan-1",
        }),
      ])

      const incomingLinksResponse = await fetch(
        `${baseUrl}/api/objects/device/fan-1/links?direction=incoming`
      )
      expect(incomingLinksResponse.status).toBe(200)
      const incomingLinks = (await incomingLinksResponse.json()) as Array<{ sourceId: string }>
      expect(incomingLinks.map((link) => link.sourceId)).toEqual(["system"])

      const invalidDirectionResponse = await fetch(
        `${baseUrl}/api/objects/device/fan-1/links?direction=sideways`
      )
      expect(invalidDirectionResponse.status).toBe(422)

      const historyResponse = await fetch(
        `${baseUrl}/api/objects/device/fan-1/telemetry/rpm/history?limit=2&order=desc`
      )
      expect(historyResponse.status).toBe(200)
      const history = (await historyResponse.json()) as Array<{ value: number }>
      expect(history.map((point) => point.value)).toEqual([1200, 1100])

      const bulkHistoryResponse = await fetch(`${baseUrl}/api/telemetry/history`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          series: [
            { objectTypeId: "device", objectId: "fan-1", propertyId: "rpm" },
            { objectTypeId: "device", objectId: "fan-1", propertyId: "online" },
            { objectTypeId: "device", objectId: "missing", propertyId: "rpm" },
            { objectTypeId: "device", objectId: "missing", propertyId: "online" },
          ],
          limitPerSeries: 1,
          order: "desc",
        }),
      })
      expect(bulkHistoryResponse.status).toBe(200)
      const bulkHistory = (await bulkHistoryResponse.json()) as {
        series: Array<{
          objectId: string
          propertyId: string
          points: Array<{ value: number | boolean }>
        }>
      }
      expect(bulkHistory.series).toHaveLength(4)
      expect(
        bulkHistory.series
          .find((series) => series.objectId === "fan-1" && series.propertyId === "rpm")
          ?.points.map((point) => point.value)
      ).toEqual([1200])
      expect(
        bulkHistory.series
          .find((series) => series.objectId === "fan-1" && series.propertyId === "online")
          ?.points.map((point) => point.value)
      ).toEqual([true])
      expect(
        bulkHistory.series.find(
          (series) => series.objectId === "missing" && series.propertyId === "rpm"
        )?.points
      ).toEqual([])

      const latestResponse = await fetch(`${baseUrl}/api/objects/device/fan-1/telemetry/rpm/latest`)
      expect(latestResponse.status).toBe(200)
      const latest = (await latestResponse.json()) as { value: number }
      expect(latest.value).toBe(1200)

      const eventsResponse = await fetch(`${baseUrl}/api/events?topic=telemetry&limit=10`)
      expect(eventsResponse.status).toBe(200)
      const events = (await eventsResponse.json()) as {
        count: number
        events: Array<{ type: string }>
      }
      expect(events.count).toBeGreaterThanOrEqual(2)
      expect(events.events.some((event) => event.type === "telemetry.appended")).toBe(true)
    })
  })

  test("serializes expand links on the query route", async () => {
    await withHttpContractServer(async ({ baseUrl }) => {
      // `space` contains `device` ("many"); the setup links system → fan-1.
      const response = await fetch(`${baseUrl}/api/objects/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            kind: "expand",
            input: { kind: "limit", limit: 5, input: { kind: "start", objectTypeId: "space" } },
            expansions: [{ linkId: "contains", direction: "outgoing" }],
          },
        }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        plan: { mode: string }
        objects: Array<{
          primaryId: string
          links?: Record<
            string,
            Array<{ primaryId: string; objectTypeId: string; properties: Record<string, unknown> }>
          >
        }>
      }

      // The SQLite provider speaks expand, so it hydrates links via pushdown.
      expect(body.plan.mode).toBe("pushdown")
      const system = body.objects.find((object) => object.primaryId === "system")
      // "many" cardinality serializes as an array of the linked objects.
      expect(system?.links?.contains).toEqual([
        expect.objectContaining({
          primaryId: "fan-1",
          objectTypeId: "device",
          properties: expect.objectContaining({ label: "Fan 1" }),
        }),
      ])
    })
  })

  test("supports workflow intervention review endpoints", async () => {
    await withHttpContractServer(async ({ baseUrl, events, sixb }) => {
      const pending = await seedPendingReviewIntervention(sixb, "submit")

      const listResponse = await fetch(
        `${baseUrl}/api/workflow-interventions?status=pending&workflowId=review-device-health-workflow`
      )
      expect(listResponse.status).toBe(200)
      expect(await listResponse.json()).toMatchObject({
        total: 1,
        hasMore: false,
        interventions: [
          {
            id: pending.id,
            workflowId: "review-device-health-workflow",
            workflowRunId: pending.workflowRunId,
            nodeRunId: pending.nodeRunId,
            nodeId: "review-device-health",
            nodeKey: "reviewDeviceHealth",
            interventionId: "review-device-health",
            status: "pending",
            input: { deviceId: "fan-1", healthy: true },
            defaultResponse: { approved: true },
            requestedAt: "2026-02-18T09:20:04.000Z",
          },
        ],
      })

      const detailResponse = await fetch(`${baseUrl}/api/workflow-interventions/${pending.id}`)
      expect(detailResponse.status).toBe(200)
      expect(await detailResponse.json()).toMatchObject({
        id: pending.id,
        workflowId: "review-device-health-workflow",
        status: "pending",
      })

      const invalidSubmitResponse = await fetch(
        `${baseUrl}/api/workflow-interventions/${pending.id}/submit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: { approved: "yes" } }),
        }
      )
      expect(invalidSubmitResponse.status).toBe(400)

      const validSubmitResponse = await fetch(
        `${baseUrl}/api/workflow-interventions/${pending.id}/submit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            response: { approved: false, note: "Needs inspection." },
          }),
        }
      )
      expect(validSubmitResponse.status).toBe(202)
      const validSubmitBody = (await validSubmitResponse.json()) as {
        jobId: string
        intervention: {
          id: string
          status: string
          response: Record<string, unknown>
          submittedBy: { principalType: string; principalId: string }
        }
      }
      expect(validSubmitBody.jobId).toBeTruthy()
      expect(validSubmitBody.intervention).toMatchObject({
        id: pending.id,
        status: "submitted",
        response: { approved: false, note: "Needs inspection." },
        submittedBy: { principalType: "system", principalId: "system" },
      })

      const [resumeJob] = await sixb.queues.workflows.claim({
        projectId: sixb.id,
        workerId: "contract-test",
      })
      expect(resumeJob?.job.id).toBe(validSubmitBody.jobId)
      expect(resumeJob?.job).toEqual({
        id: validSubmitBody.jobId,
        projectId: sixb.id,
        createdAt: expect.any(String),
        availableAt: expect.any(String),
        attempt: 1,
        metadata: undefined,
        type: "workflow.run.resume.requested",
        payload: {
          runId: pending.workflowRunId,
          resume: { kind: "intervention", interventionId: pending.id },
        },
      })

      const duplicateSubmitResponse = await fetch(
        `${baseUrl}/api/workflow-interventions/${pending.id}/submit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: { approved: true } }),
        }
      )
      expect(duplicateSubmitResponse.status).toBe(400)

      const duplicateResumeJobs = await sixb.queues.workflows.claim({
        projectId: sixb.id,
        workerId: "contract-test-duplicate",
      })
      expect(duplicateResumeJobs).toEqual([])

      const workflowEvents = await events.read({
        topics: ["workflows"],
        types: ["workflow.intervention.submitted"],
        limit: 10,
      })
      expect(workflowEvents).toEqual([
        expect.objectContaining({
          type: "workflow.intervention.submitted",
          payload: expect.objectContaining({
            workflowId: "review-device-health-workflow",
            runId: pending.workflowRunId,
            nodeRunId: pending.nodeRunId,
            interventionId: "review-device-health",
            pendingInterventionId: pending.id,
          }),
        }),
      ])
    })
  })

  test("cancels pending workflow interventions and waiting runs", async () => {
    await withHttpContractServer(async ({ baseUrl, events, sixb }) => {
      const pending = await seedPendingReviewIntervention(sixb, "cancel")

      const cancelResponse = await fetch(
        `${baseUrl}/api/workflow-interventions/${pending.id}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }
      )
      expect(cancelResponse.status).toBe(200)
      expect(await cancelResponse.json()).toMatchObject({
        intervention: {
          id: pending.id,
          status: "cancelled",
          cancelledBy: { principalType: "system", principalId: "system" },
        },
      })

      const cancelledRun = await sixb.storage.workflowRuns!.getById({
        projectId: sixb.id,
        id: pending.workflowRunId,
      })
      expect(cancelledRun).toMatchObject({
        id: pending.workflowRunId,
        status: "cancelled",
        error: "Workflow intervention cancelled.",
      })

      const cancelledNode = await sixb.storage.workflowRuns!.nodes.getById({
        projectId: sixb.id,
        id: pending.nodeRunId,
      })
      expect(cancelledNode).toMatchObject({
        id: pending.nodeRunId,
        status: "cancelled",
        error: "Workflow intervention cancelled.",
      })

      const workflowEvents = await events.read({
        topics: ["workflows"],
        types: [
          "workflow.intervention.cancelled",
          "workflow.run.node.finished",
          "workflow.run.finished",
        ],
        limit: 10,
      })
      expect(workflowEvents.map((event) => event.type)).toEqual([
        "workflow.intervention.cancelled",
        "workflow.run.node.finished",
        "workflow.run.finished",
      ])
      expect(workflowEvents[0]).toMatchObject({
        payload: expect.objectContaining({
          workflowId: "review-device-health-workflow",
          runId: pending.workflowRunId,
          nodeRunId: pending.nodeRunId,
          pendingInterventionId: pending.id,
        }),
      })
    })
  })

  test("exposes agent node diagnostics without ownership tokens and cancels atomically", async () => {
    await withHttpContractServer(async ({ baseUrl, sixb }) => {
      const runs = sixb.storage.workflowRuns!
      const runId = "workflow-agent-observability"
      const nodeRunId = `${runId}:node:0`
      const workflowExecutionId = await createTestWorkflowExecution(sixb.storage.executions, {
        projectId: sixb.id,
        workflowId: "review-device-health-workflow",
        runId,
      })
      await runs.queue({
        id: runId,
        projectId: sixb.id,
        executionId: workflowExecutionId,
        workflowId: "review-device-health-workflow",
        input: { deviceId: "fan-1" },
      })
      await runs.start({ id: runId, projectId: sixb.id })
      await runs.nodes.start({
        id: nodeRunId,
        projectId: sixb.id,
        workflowRunId: runId,
        workflowId: "review-device-health-workflow",
        nodeIndex: 0,
        nodeType: "agent",
        nodeId: "resolve-device",
        nodeKey: "resolveDevice",
        input: { deviceId: "fan-1" },
      })
      await runs.agentNodes.create({
        projectId: sixb.id,
        nodeRunId,
        agentId: "device-resolver",
        prompt: "Resolve fan-1.",
      })
      await runs.nodes.wait({ projectId: sixb.id, id: nodeRunId })
      await runs.wait({ projectId: sixb.id, id: runId })
      await runs.agentNodes.start({
        projectId: sixb.id,
        nodeRunId,
        modelId: "test-model",
        execution: {
          token: "secret-execution-token",
          queueLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      })

      const detailResponse = await fetch(
        `${baseUrl}/api/workflow-runs/${runId}/nodes/resolveDevice/agent-execution`
      )
      expect(detailResponse.status).toBe(200)
      const detail = (await detailResponse.json()) as Record<string, unknown>
      expect(detail).toMatchObject({
        nodeRunId,
        agentId: "device-resolver",
        status: "running",
        prompt: "Resolve fan-1.",
        modelId: "test-model",
      })
      expect(JSON.stringify(detail)).not.toContain("secret-execution-token")

      const cancelResponse = await fetch(`${baseUrl}/api/workflow-runs/${runId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(cancelResponse.status).toBe(200)
      expect(await cancelResponse.json()).toMatchObject({
        run: { id: runId, status: "cancelled" },
        nodes: [
          {
            id: nodeRunId,
            status: "cancelled",
            agentExecution: { status: "cancelled", agentId: "device-resolver" },
          },
        ],
      })
    })
  })

  test("supports documented write endpoints", async () => {
    await withHttpContractServer(async ({ baseUrl, events, sixb }) => {
      const upsertObjectResponse = await fetch(`${baseUrl}/api/objects/device/fan-2`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ properties: { id: "fan-2", label: "Fan 2" } }),
      })
      expect(upsertObjectResponse.status).toBe(200)

      const appendTelemetryResponse = await fetch(
        `${baseUrl}/api/objects/device/fan-2/telemetry/rpm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: 900, at: "2026-02-18T10:05:00.000Z" }),
        }
      )
      expect(appendTelemetryResponse.status).toBe(200)
      expect(await appendTelemetryResponse.json()).toEqual({ success: true })

      const requestActionResponse = await fetch(`${baseUrl}/api/actions/setSpeed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: {
            kind: "object",
            objectTypeId: "device",
            primaryId: "fan-2",
          },
          params: { speed: null },
        }),
      })
      expect(requestActionResponse.status).toBe(202)
      const requestActionBody = (await requestActionResponse.json()) as {
        runId: string
        queuedAt: string
        created: boolean
        jobId?: string
      }
      expect(requestActionBody.runId.startsWith("act_")).toBe(true)
      expect(new Date(requestActionBody.queuedAt).toISOString()).toBe(requestActionBody.queuedAt)
      expect(requestActionBody.created).toBe(true)
      expect(requestActionBody.jobId).toBeTruthy()

      const requestCreateMaintenanceRunResponse = await fetch(
        `${baseUrl}/api/actions/createMaintenanceRun`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            params: { note: "Inspect fan vibration" },
            runId: "act_contract_global",
          }),
        }
      )
      expect(requestCreateMaintenanceRunResponse.status).toBe(202)
      expect(await requestCreateMaintenanceRunResponse.json()).toEqual({
        runId: "act_contract_global",
        queuedAt: expect.any(String),
        jobId: expect.any(String),
        created: true,
      })

      const actionRunsResponse = await fetch(`${baseUrl}/api/action-runs?status=queued`)
      expect(actionRunsResponse.status).toBe(200)
      const actionRunsBody = (await actionRunsResponse.json()) as {
        runs: Array<{ id: string; status: string; actionId: string }>
        hasMore: boolean
        total: number
      }
      expect(actionRunsBody.total).toBe(2)
      expect(actionRunsBody.hasMore).toBe(false)
      expect(actionRunsBody.runs.map((run) => run.id).sort()).toEqual(
        [requestActionBody.runId, "act_contract_global"].sort()
      )

      const objectActionRunsResponse = await fetch(
        `${baseUrl}/api/action-runs?actionId=setSpeed&objectTypeId=device&primaryId=fan-2`
      )
      expect(objectActionRunsResponse.status).toBe(200)
      expect(await objectActionRunsResponse.json()).toMatchObject({
        runs: [
          {
            id: requestActionBody.runId,
            projectId: "contract-project",
            actionId: "setSpeed",
            subject: {
              kind: "object",
              objectTypeId: "device",
              primaryId: "fan-2",
            },
            status: "queued",
            queuedAt: expect.any(String),
          },
        ],
        hasMore: false,
        total: 1,
      })

      const queuedActionRunResponse = await fetch(
        `${baseUrl}/api/action-runs/${requestActionBody.runId}`
      )
      expect(queuedActionRunResponse.status).toBe(200)
      expect(await queuedActionRunResponse.json()).toMatchObject({
        id: requestActionBody.runId,
        projectId: "contract-project",
        actionId: "setSpeed",
        subject: {
          kind: "object",
          objectTypeId: "device",
          primaryId: "fan-2",
        },
        status: "queued",
        params: { speed: null },
      })

      const completedActionRunResponse = await fetch(
        `${baseUrl}/api/action-runs/act_audit_previous`
      )
      expect(completedActionRunResponse.status).toBe(200)
      const completedActionRunBody = await completedActionRunResponse.json()
      expect(completedActionRunBody).toEqual({
        id: "act_audit_previous",
        projectId: "contract-project",
        actionId: "syncDeviceLabel",
        subject: {
          kind: "object",
          objectTypeId: "device",
          primaryId: "fan-1",
        },
        status: "succeeded",
        phase: "effects",
        queuedAt: "2026-02-18T09:12:00.000Z",
        startedAt: "2026-02-18T09:12:01.000Z",
        finishedAt: "2026-02-18T09:12:05.000Z",
        params: { label: "Fan 1 audited" },
        writeback: {
          status: "succeeded",
          completedAt: "2026-02-18T09:12:02.000Z",
          result: { externalId: "ext_123" },
        },
        effects: {
          status: "failed",
          completedAt: "2026-02-18T09:12:04.000Z",
          error: {
            name: "NotificationError",
            message: "Notification failed",
            phase: "effects",
          },
        },
      })
      expect(JSON.stringify(completedActionRunBody)).not.toContain("idempotencyKey")
      expect(JSON.stringify(completedActionRunBody)).not.toContain("securityContext")

      const missingActionRunResponse = await fetch(`${baseUrl}/api/action-runs/missing`)
      expect(missingActionRunResponse.status).toBe(404)
      expect(await missingActionRunResponse.json()).toEqual({ error: "Action run not found" })

      const missingSubjectResponse = await fetch(`${baseUrl}/api/actions/setSpeed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: { speed: 975 } }),
      })
      expect(missingSubjectResponse.status).toBe(400)
      expect(await missingSubjectResponse.json()).toEqual({
        error: "Action 'setSpeed' requires an object subject.",
      })

      const upsertLinkResponse = await fetch(`${baseUrl}/api/objects/space/system/links/contains`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetTypeId: "device", targetId: "fan-2" }),
      })
      expect(upsertLinkResponse.status).toBe(200)
      expect(await upsertLinkResponse.json()).toEqual({ success: true })

      const latestTelemetryResponse = await fetch(
        `${baseUrl}/api/objects/device/fan-2/telemetry/rpm/latest`
      )
      expect(latestTelemetryResponse.status).toBe(200)
      expect(await latestTelemetryResponse.json()).toMatchObject({ value: 900 })

      const linksResponse = await fetch(`${baseUrl}/api/objects/space/system/links?linkId=contains`)
      const links = (await linksResponse.json()) as Array<{ targetId: string }>
      expect(links.some((linkRow) => linkRow.targetId === "fan-2")).toBe(true)

      const actionEvents = await events.read({
        topics: ["actions"],
        limit: 10,
      })
      expect(actionEvents).toEqual([
        expect.objectContaining({
          type: "action.requested",
          payload: {
            actionId: "setSpeed",
            subject: {
              kind: "object",
              objectTypeId: "device",
              primaryId: "fan-2",
            },
            params: { speed: null },
            runId: requestActionBody.runId,
          },
        }),
        expect.objectContaining({
          type: "action.requested",
          payload: {
            actionId: "createMaintenanceRun",
            subject: { kind: "none" },
            params: { note: "Inspect fan vibration" },
            runId: "act_contract_global",
          },
        }),
      ])

      const removeLinkResponse = await fetch(
        `${baseUrl}/api/objects/space/system/links/contains?targetTypeId=device&targetId=fan-2`,
        { method: "DELETE" }
      )
      expect(removeLinkResponse.status).toBe(200)
      expect(await removeLinkResponse.json()).toEqual({ success: true })

      const requestSyncRunResponse = await fetch(`${baseUrl}/api/syncs/sync-github-events/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commitMessage: "manual import" }),
      })
      expect(requestSyncRunResponse.status).toBe(202)
      const requestSyncRunBody = (await requestSyncRunResponse.json()) as {
        runId: string
        jobId: string
        syncId: string
      }
      expect(requestSyncRunBody.runId).toStartWith("run_")
      expect(requestSyncRunBody.jobId).toBeTruthy()
      expect(requestSyncRunBody.syncId).toBe("sync-github-events")

      const [queuedSyncRun] = await sixb.queues.syncRuns.claim({
        projectId: sixb.id,
        workerId: "contract-test",
      })
      expect(queuedSyncRun?.job.payload).toEqual({
        syncId: "sync-github-events",
        runId: requestSyncRunBody.runId,
        expectedLatestVersionId: undefined,
        commitMessage: "manual import",
      })

      const requestPipelineRunResponse = await fetch(
        `${baseUrl}/api/pipelines/github-events-pipeline/runs`,
        { method: "POST" }
      )
      expect(requestPipelineRunResponse.status).toBe(202)
      const requestPipelineRunBody = (await requestPipelineRunResponse.json()) as {
        runId: string
        jobId: string
        pipelineId: string
      }
      expect(requestPipelineRunBody.runId).toStartWith("run_")
      expect(requestPipelineRunBody.jobId).toBeTruthy()
      expect(requestPipelineRunBody.pipelineId).toBe("github-events-pipeline")

      const [queuedPipelineRun] = await sixb.queues.pipelines.claim({
        projectId: sixb.id,
        workerId: "contract-test",
      })
      expect(queuedPipelineRun?.job.payload).toEqual({
        pipelineId: "github-events-pipeline",
        runId: requestPipelineRunBody.runId,
      })

      const requestWorkflowRunResponse = await fetch(
        `${baseUrl}/api/workflows/inspect-device-workflow/runs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: { deviceId: "fan-2" } }),
        }
      )
      expect(requestWorkflowRunResponse.status).toBe(202)
      const requestWorkflowRunBody = (await requestWorkflowRunResponse.json()) as {
        runId: string
        jobId: string
        workflowId: string
      }
      expect(requestWorkflowRunBody.runId).toStartWith("run_")
      expect(requestWorkflowRunBody.jobId).toBeTruthy()
      expect(requestWorkflowRunBody.workflowId).toBe("inspect-device-workflow")

      const queuedWorkflowRunRecord = await sixb.storage.workflowRuns!.getById({
        projectId: sixb.id,
        id: requestWorkflowRunBody.runId,
      })
      expect(queuedWorkflowRunRecord).toMatchObject({
        id: requestWorkflowRunBody.runId,
        workflowId: "inspect-device-workflow",
        status: "queued",
        input: { deviceId: "fan-2" },
      })

      const [queuedWorkflowRun] = await sixb.queues.workflows.claim({
        projectId: sixb.id,
        workerId: "contract-test",
      })
      expect(queuedWorkflowRun?.job.payload).toEqual({ runId: requestWorkflowRunBody.runId })

      const workflowEvents = await events.read({
        topics: ["workflows"],
        types: ["workflow.run.queued"],
        limit: 10,
      })
      expect(workflowEvents).toEqual([
        expect.objectContaining({
          type: "workflow.run.queued",
          payload: expect.objectContaining({
            workflowId: "inspect-device-workflow",
            runId: requestWorkflowRunBody.runId,
            jobId: requestWorkflowRunBody.jobId,
            source: { type: "manual" },
          }),
        }),
      ])
    })
  })

  test("separates a bad write body from a name the ontology does not register", async () => {
    await withHttpContractServer(async ({ baseUrl }) => {
      // The status used to be picked by searching the message for "Unknown" or "not found", so
      // every ontology validation error whose text began "Unknown property" answered 404. To see
      // this fail, drop the OntologyValidationError branch from `handleRouteError`.
      const unknownProperty = await fetch(`${baseUrl}/api/objects/device/fan-2`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ properties: { id: "fan-2", nope: "x" } }),
      })
      expect(unknownProperty.status).toBe(400)

      const unknownObjectType = await fetch(`${baseUrl}/api/objects/ghost/fan-2`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ properties: {} }),
      })
      expect(unknownObjectType.status).toBe(404)

      // A link id is named in the path, so an unregistered one is still missing, not malformed.
      const unknownLink = await fetch(`${baseUrl}/api/objects/space/system/links/ghost`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetTypeId: "device", targetId: "fan-2" }),
      })
      expect(unknownLink.status).toBe(404)
    })
  })
})
