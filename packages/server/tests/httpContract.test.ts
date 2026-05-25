import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  actionParam,
  col,
  datasetUpdated,
  defineAction,
  defineConnector,
  defineDataset,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineRule,
  defineSchedule,
  defineSync,
  defineWebhook,
  defineWorkflow,
  defineWorkflowStep,
  type EventsRuntime,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  link,
  type OntologySource,
  Pario,
  type ParioOptions,
  prop,
} from "@pario/core"
import {
  SqliteObjectStorage,
  SqlitePipelineRunStorage,
  SqliteRulesStorage,
  SqliteSyncRunStorage,
  SqliteTimeseriesStorage,
  SqliteWebhookRunStorage,
  SqliteWorkflowRunStorage,
} from "@pario/sqlite"
import { ParioServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

function createParioInstance<TOntologySources extends readonly OntologySource[]>(
  options: ParioOptions<TOntologySources>
): Pario<TOntologySources> {
  const ParioConstructor = Pario as unknown as new (
    options: ParioOptions<TOntologySources>
  ) => Pario<TOntologySources>

  return new ParioConstructor(options)
}

const Space = defineObjectType({
  id: "space",
  name: "Space",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
  links: [link("contains", "device", { cardinality: "many" })],
})

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("label", "string", { required: true }),
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
  .when(datasetUpdated(githubEventsDataset.id))
  .then(cleanGithubEventsStep)

const inspectDeviceStep = defineWorkflowStep("inspect-device")
  .input({ deviceId: "string" })
  .output({ deviceId: "string", healthy: "boolean" })
  .run(({ input }) => ({ deviceId: input.deviceId, healthy: true }))

const inspectDeviceWorkflow = defineWorkflow("inspect-device-workflow")
  .input({ deviceId: "string" })
  .when(nightlyGithub)
  .then(inspectDeviceStep)

const setSpeed = defineAction("setSpeed")
  .target(Device)
  .params({ speed: actionParam("double", { required: true }) })
  .run(async () => {})

const createMaintenanceRun = defineAction("createMaintenanceRun")
  .params({ note: actionParam("string", { required: true }) })
  .run(async () => {})

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

describe("ParioServer HTTP contract", () => {
  async function withHttpContractServer(
    run: (context: {
      baseUrl: string
      events: EventsRuntime
      pario: Pario<readonly OntologySource[]>
    }) => Promise<void>
  ): Promise<void> {
    const tempRoot = await mkdtemp(join(tmpdir(), "pario-http-contract-"))

    const lakeStorage = new InMemoryLakeStorage()
    const pario = createParioInstance<readonly OntologySource[]>({
      id: "contract-project",
      ontology: [Space, Device],
      actions: [setSpeed, createMaintenanceRun],
      broker: new InMemoryBroker(),
      storage: {
        objects: new SqliteObjectStorage(),
        timeseries: new SqliteTimeseriesStorage(),
        syncRuns: new SqliteSyncRunStorage(),
        pipelineRuns: new SqlitePipelineRunStorage(),
        workflowRuns: new SqliteWorkflowRunStorage(),
        webhookRuns: new SqliteWebhookRunStorage(),
        rules: new SqliteRulesStorage(),
      },
      lakeStorage,
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      connectors: [githubConnector],
      schedules: [nightlyGithub],
      datasets: [githubEventsDataset, auditLogDataset, cleanGithubEventsDataset],
      syncs: [githubEventsSync],
      pipelines: [githubEventsPipeline],
      workflows: [inspectDeviceWorkflow],
      rules: [highRpmRule],
    })

    await pario.upsertObject("space", { id: "system", name: "System" })
    await pario.upsertObject("device", { id: "fan-1", label: "Fan 1" })
    await pario.upsertLink("space", "system", "contains", {
      targetTypeId: "device",
      targetId: "fan-1",
    })

    await pario.appendTelemetry("device", [
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

    await pario.storage.rules!.applyTriggered({
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

    await pario.storage.syncRuns!.start({
      id: "run-previous",
      projectId: "contract-project",
      syncId: "sync-github-events",
      datasetId: "raw.github.events",
      mode: "append",
      startedAt: new Date("2026-02-18T09:00:00.000Z"),
      commitMessage: "previous import",
    })
    await pario.storage.syncRuns!.finish({
      id: "run-previous",
      projectId: "contract-project",
      status: "succeeded",
      finishedAt: new Date("2026-02-18T09:00:03.000Z"),
      rowsRead: 3,
      output: {
        datasetId: "raw.github.events",
        versionId: committedVersion.versionId,
      },
    })

    await pario.storage.pipelineRuns!.start({
      id: "pipeline-run-previous",
      projectId: "contract-project",
      pipelineId: "github-events-pipeline",
      startedAt: new Date("2026-02-18T09:05:00.000Z"),
    })
    await pario.storage.pipelineRuns!.startStep({
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
    await pario.storage.pipelineRuns!.finishStep({
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
    await pario.storage.pipelineRuns!.finish({
      id: "pipeline-run-previous",
      projectId: "contract-project",
      status: "succeeded",
      finishedAt: new Date("2026-02-18T09:05:02.000Z"),
      output: {
        datasetId: "clean.github.events",
        versionId: "ver_pipeline_previous",
      },
    })

    await pario.storage.workflowRuns!.start({
      id: "workflow-run-previous",
      projectId: "contract-project",
      workflowId: "inspect-device-workflow",
      input: { deviceId: "fan-1" },
      startedAt: new Date("2026-02-18T09:07:00.000Z"),
    })
    await pario.storage.workflowRuns!.nodes.start({
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
    await pario.storage.workflowRuns!.nodes.finish({
      id: "workflow-node-run-previous",
      projectId: "contract-project",
      status: "succeeded",
      finishedAt: new Date("2026-02-18T09:07:01.000Z"),
      output: { deviceId: "fan-1", healthy: true },
    })
    await pario.storage.workflowRuns!.finish({
      id: "workflow-run-previous",
      projectId: "contract-project",
      status: "succeeded",
      finishedAt: new Date("2026-02-18T09:07:02.000Z"),
    })

    await pario.storage.webhookRuns!.start({
      id: "webhook-run-previous",
      projectId: "contract-project",
      connectorId: "github",
      webhookId: "events",
      method: "POST",
      route: "/api/webhooks/github/events",
      startedAt: new Date("2026-02-18T09:10:00.000Z"),
    })
    await pario.storage.webhookRuns!.finish({
      id: "webhook-run-previous",
      projectId: "contract-project",
      status: "succeeded",
      finishedAt: new Date("2026-02-18T09:10:01.000Z"),
      requestBodyBytes: 18,
      responseStatus: 202,
    })

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`

    const server = new ParioServer({
      pario,
      host: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
    })

    await server.start()

    try {
      await run({ baseUrl, events: pario.events, pario })
    } finally {
      await server.stop()
      await rm(tempRoot, { recursive: true, force: true })
    }
  }

  test("serves documented read endpoints", async () => {
    await withHttpContractServer(async ({ baseUrl }) => {
      const projectResponse = await fetch(`${baseUrl}/api/project`)
      expect(projectResponse.status).toBe(200)
      expect(await projectResponse.json()).toEqual({ id: "contract-project", type: "local" })

      const statusResponse = await fetch(`${baseUrl}/api/status`)
      expect(statusResponse.status).toBe(200)
      expect(await statusResponse.json()).toEqual({
        status: "ok",
        objectTypes: 2,
        functions: 0,
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
      expect(await syncRunsResponse.json()).toMatchObject({
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

      const pipelinesResponse = await fetch(`${baseUrl}/api/pipelines`)
      expect(pipelinesResponse.status).toBe(200)
      const pipelines = (await pipelinesResponse.json()) as Array<{
        id: string
        triggers: Array<{ type: string; datasetId?: string }>
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
          triggers: [{ type: "dataset.updated", datasetId: "raw.github.events" }],
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
      expect(await workflowsResponse.json()).toEqual([
        expect.objectContaining({
          id: "inspect-device-workflow",
          input: { deviceId: "string" },
          triggers: [{ type: "schedule", scheduleId: "nightly-github" }],
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
            input: { deviceId: "fan-1" },
          }),
        }),
      ])

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
      expect(await workflowRunsResponse.json()).toMatchObject({
        total: 1,
        hasMore: false,
        runs: [
          {
            id: "workflow-run-previous",
            workflowId: "inspect-device-workflow",
            status: "succeeded",
            input: { deviceId: "fan-1" },
          },
        ],
      })

      const workflowRunResponse = await fetch(`${baseUrl}/api/workflow-runs/workflow-run-previous`)
      expect(workflowRunResponse.status).toBe(200)
      expect(await workflowRunResponse.json()).toMatchObject({
        run: {
          id: "workflow-run-previous",
          workflowId: "inspect-device-workflow",
          status: "succeeded",
          input: { deviceId: "fan-1" },
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
              type: "object.upserted",
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
        actions: Array<{ id: string }>
      }
      expect(objectType.id).toBe("device")
      expect(objectType.actions[0]?.id).toBe("setSpeed")

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

      const historyResponse = await fetch(
        `${baseUrl}/api/objects/device/fan-1/telemetry/rpm/history?limit=2&order=desc`
      )
      expect(historyResponse.status).toBe(200)
      const history = (await historyResponse.json()) as Array<{ value: number }>
      expect(history.map((point) => point.value)).toEqual([1200, 1100])

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

  test("supports documented write endpoints", async () => {
    await withHttpContractServer(async ({ baseUrl, events, pario }) => {
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

      const requestActionResponse = await fetch(
        `${baseUrl}/api/objects/device/fan-2/actions/setSpeed`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ params: { speed: 950 } }),
        }
      )
      expect(requestActionResponse.status).toBe(200)
      const requestActionBody = (await requestActionResponse.json()) as {
        success: boolean
        runId: string
      }
      expect(requestActionBody.success).toBe(true)
      expect(requestActionBody.runId.startsWith("act_")).toBe(true)

      const requestGlobalActionResponse = await fetch(
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
      expect(requestGlobalActionResponse.status).toBe(200)
      expect(await requestGlobalActionResponse.json()).toEqual({
        success: true,
        runId: "act_contract_global",
      })

      const invalidGlobalActionResponse = await fetch(`${baseUrl}/api/actions/setSpeed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: { speed: 975 } }),
      })
      expect(invalidGlobalActionResponse.status).toBe(400)
      expect(await invalidGlobalActionResponse.json()).toEqual({
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
            params: { speed: 950 },
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

      const [queuedSyncRun] = await pario.queues.syncRuns.claim({
        projectId: pario.id,
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

      const [queuedPipelineRun] = await pario.queues.pipelines.claim({
        projectId: pario.id,
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

      const queuedWorkflowRunRecord = await pario.storage.workflowRuns!.getById({
        projectId: pario.id,
        id: requestWorkflowRunBody.runId,
      })
      expect(queuedWorkflowRunRecord).toMatchObject({
        id: requestWorkflowRunBody.runId,
        workflowId: "inspect-device-workflow",
        status: "queued",
        input: { deviceId: "fan-2" },
      })

      const [queuedWorkflowRun] = await pario.queues.workflows.claim({
        projectId: pario.id,
        workerId: "contract-test",
      })
      expect(queuedWorkflowRun?.job.payload).toEqual({
        workflowId: "inspect-device-workflow",
        runId: requestWorkflowRunBody.runId,
        input: { deviceId: "fan-2" },
      })

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
})
