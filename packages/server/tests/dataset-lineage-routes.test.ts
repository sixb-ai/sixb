import { describe, expect, test } from "bun:test"
import {
  can,
  col,
  type DatasetDefinition,
  type DatasetProducer,
  type DatasetVersionRef,
  defineDataset,
  defineGroup,
  definePipeline,
  definePipelineStep,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// An orders report a pipeline computes from the raw export and from staged orders. Analysts view
// the report and the raw export, not the staged orders, and cannot view the pipeline's runs.
// Operators view every dataset and run the pipeline; outsiders view nothing. What each reader may
// see of a version's origin is owned by core's dataset-lineage.test.ts; this proves the routes
// apply it.

const projectId = "dataset-lineage-routes"

const rawOrders = defineDataset("raw_orders", { schema: [col("id", "string")] })
const stagedOrders = defineDataset("staged_orders", { schema: [col("id", "string")] })
const ordersReport = defineDataset("orders_report", { schema: [col("id", "string")] })

const reportOrders = definePipeline("report-orders").then(
  definePipelineStep("report")
    .inputs({ raw: rawOrders, staged: stagedOrders })
    .output(ordersReport)
    .run(() => {})
)
const reportProducer = {
  kind: "pipeline",
  id: reportOrders.id,
  runId: "report-run",
  stepId: "report",
} as const

const analysts = defineGroup("analysts")
const operators = defineGroup("operators")
const roles = [
  defineRole("analyst", { grantedTo: [analysts], grants: [can.view([rawOrders, ordersReport])] }),
  defineRole("operator", {
    grantedTo: [operators],
    grants: [can.view([rawOrders, stagedOrders, ordersReport]), can.run(reportOrders)],
  }),
]

async function createApp() {
  const storage = new InMemoryStorage()
  const lakeStorage = new InMemoryLakeStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    datasets: [rawOrders, stagedOrders, ordersReport],
    pipelines: [reportOrders],
    groups: [analysts, operators],
    roles,
    broker: new InMemoryBroker(),
    storage,
    lakeStorage,
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: { id: "test", kind: "dev" },
  })

  const raw = await commit(lakeStorage, rawOrders, { kind: "ingest" })
  const staged = await commit(lakeStorage, stagedOrders, { kind: "ingest" })
  const report = await commit(lakeStorage, ordersReport, reportProducer, [raw, staged])

  const callers = {
    analyst: await seedSession(storage, "usr_analyst", [analysts.id]),
    operator: await seedSession(storage, "usr_operator", [operators.id]),
    outsider: await seedSession(storage, "usr_outsider", []),
  }
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  const get = (caller: keyof typeof callers, path: string) =>
    app.fetch(new Request(`http://localhost/api/datasets${path}`, { headers: callers[caller] }))

  return { get, lakeStorage, raw, staged, report }
}

/** Commit one version straight to the lake, as its producer would. */
async function commit(
  lakeStorage: InMemoryLakeStorage,
  dataset: DatasetDefinition,
  producer: DatasetProducer,
  inputs: readonly DatasetVersionRef[] = []
): Promise<DatasetVersionRef> {
  await lakeStorage.createDataset(dataset)
  const session = await lakeStorage.beginWrite({ dataset, producer, inputs })

  await session.writeRows([{ id: "order-1" }])
  const { datasetId, versionId } = await session.commit()
  return { datasetId, versionId }
}

async function seedSession(storage: InMemoryStorage, userId: string, groupIds: readonly string[]) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({ id: userId, projectId, email: `${userId}@acme.com` })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({ projectId, userId, groupId, source: "manual" })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId,
    strategyId: "test",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-10-31T10:00:00.000Z"),
    expiresAt: new Date("2099-10-31T10:00:00.000Z"),
  })
  return { cookie: `sixb_session_app=${credential.cookieValue}` }
}

describe("dataset version routes", () => {
  // Guard proof: read the versions from `host.lakeStorage` again in routes/datasets.ts; the analyst
  // then sees the pipeline run and the staged version.
  test("show a version's producer and inputs as far as the caller may see them", async () => {
    const { get, raw, staged, report } = await createApp()
    const reportPath = `/${ordersReport.id}/versions/${report.versionId}`

    const operatorVersion = await (await get("operator", reportPath)).json()
    expect(operatorVersion).toMatchObject({
      producer: { kind: "pipeline", id: reportOrders.id, runId: "report-run" },
      inputs: [raw, staged],
    })

    const analystVersion = await (await get("analyst", reportPath)).json()
    expect(analystVersion).toMatchObject({ producer: { kind: "pipeline" }, inputs: [raw] })
    expect(JSON.stringify(analystVersion)).not.toContain(staged.versionId)
    expect(JSON.stringify(analystVersion)).not.toContain("report-run")

    const listed = await (await get("analyst", `/${ordersReport.id}/versions`)).json()
    const rows = await (await get("analyst", `/${ordersReport.id}/rows`)).json()
    expect(listed.versions).toEqual([analystVersion])
    expect(rows.version).toEqual(analystVersion)
  })
})

describe("dataset version lineage route", () => {
  test("walks the version's inputs as far as the caller may see them", async () => {
    const { get, raw, staged, report } = await createApp()
    const lineagePath = `/${ordersReport.id}/versions/${report.versionId}/lineage`
    const node = (ref: DatasetVersionRef, producer: DatasetProducer) => ({
      ...ref,
      mode: "snapshot",
      createdAt: expect.any(String),
      producer,
    })

    const operatorResponse = await get("operator", lineagePath)
    expect(operatorResponse.status).toBe(200)
    expect(await operatorResponse.json()).toEqual({
      nodes: [
        node(report, reportProducer),
        node(raw, { kind: "ingest" }),
        node(staged, { kind: "ingest" }),
      ],
      edges: [
        { from: raw, to: report },
        { from: staged, to: report },
      ],
      restricted: 0,
      truncated: false,
    })

    expect(await (await get("analyst", lineagePath)).json()).toEqual({
      nodes: [node(report, { kind: "pipeline" }), node(raw, { kind: "ingest" })],
      edges: [{ from: raw, to: report }],
      restricted: 1,
      truncated: false,
    })
  })

  test("answers 404 for a dataset the caller cannot view and a missing version", async () => {
    const { get, report } = await createApp()

    const hidden = await get("outsider", `/${ordersReport.id}/versions/${report.versionId}/lineage`)
    const missing = await get("operator", `/${ordersReport.id}/versions/ver_missing/lineage`)

    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toMatchObject({ code: "dataset.not_found" })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: "dataset.version_not_found" })
  })

  test("serves an input version the lake no longer holds as expired", async () => {
    const { get, lakeStorage } = await createApp()
    const expired = { datasetId: rawOrders.id, versionId: "ver_expired" }
    const staged = await commit(lakeStorage, stagedOrders, { kind: "ingest" }, [expired])

    const response = await get(
      "operator",
      `/${stagedOrders.id}/versions/${staged.versionId}/lineage`
    )

    expect(response.status).toBe(200)
    expect((await response.json()).nodes).toEqual([
      { ...staged, mode: "snapshot", createdAt: expect.any(String), producer: { kind: "ingest" } },
      { ...expired, expired: true },
    ])
  })

  test("rejects a depth out of range", async () => {
    const { get, report } = await createApp()

    const response = await get(
      "operator",
      `/${ordersReport.id}/versions/${report.versionId}/lineage?depth=21`
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error).toStartWith("[Sixb] Dataset lineage depth must be")
  })
})
