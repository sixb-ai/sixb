import { describe, expect, test } from "bun:test"
import {
  AuthorizationError,
  can,
  col,
  type DatasetDefinition,
  type DatasetProducer,
  type DatasetVersion,
  type DatasetVersionRef,
  defineConnector,
  defineDataset,
  defineGroup,
  definePipeline,
  definePipelineStep,
  defineRole,
  defineSync,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import { MAX_DATASET_LINEAGE_NODES } from "../src/datasets/lineage"
import { createTestSixb } from "../src/testing"
import { createSharedTestScope } from "./shared-test-scope"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const erp = defineConnector("erp", { type: "test", connect: () => ({}) })

const rawOrders = defineDataset("raw_orders", { schema: [col("id", "string")] })
const stagedOrders = defineDataset("staged_orders", { schema: [col("id", "string")] })
const ordersReport = defineDataset("orders_report", { schema: [col("id", "string")] })

const syncOrders = defineSync("sync-orders")
  .from(erp)
  .read(() => [])
  .intoDataset(rawOrders)
const stageOrders = definePipeline("stage-orders").then(
  definePipelineStep("stage")
    .inputs({ orders: rawOrders })
    .output(stagedOrders)
    .run(() => {})
)
const reportOrders = definePipeline("report-orders").then(
  definePipelineStep("report")
    .inputs({ orders: stagedOrders })
    .output(ordersReport)
    .run(() => {})
)

const syncProducer = { kind: "sync", id: syncOrders.id, runId: "sync-run" } as const
const stageProducer = {
  kind: "pipeline",
  id: stageOrders.id,
  runId: "stage-run",
  stepId: "stage",
} as const
const reportProducer = {
  kind: "pipeline",
  id: reportOrders.id,
  runId: "report-run",
  stepId: "report",
} as const

const analysts = defineGroup("analysts")
const operators = defineGroup("operators")
const reporters = defineGroup("reporters")
const datasetViewer = defineRole("dataset-viewer", {
  grantedTo: [analysts, operators],
  grants: [can.view([rawOrders, stagedOrders, ordersReport])],
})
const ingestionOperator = defineRole("ingestion-operator", {
  grantedTo: [operators],
  grants: [can.run(syncOrders), can.run(stageOrders)],
})
const reportViewer = defineRole("report-viewer", {
  grantedTo: [reporters],
  grants: [can.view([rawOrders, ordersReport])],
})

function createHost() {
  return new SixbHost({
    id: "dataset-lineage",
    ontology: [],
    connectors: [erp],
    datasets: [rawOrders, stagedOrders, ordersReport],
    syncs: [syncOrders],
    pipelines: [stageOrders, reportOrders],
    groups: [analysts, operators, reporters],
    roles: [datasetViewer, ingestionOperator, reportViewer],
    ...createTestRuntimeDeps(),
  })
}

type Host = ReturnType<typeof createHost>

/** Commit one version straight to the lake, as its producer would. */
async function commit(
  host: Host,
  dataset: DatasetDefinition,
  producer: DatasetProducer,
  inputs: readonly DatasetVersionRef[] = [],
  id = "order-1"
): Promise<DatasetVersion> {
  await host.lakeStorage.createDataset(dataset)
  const session = await host.lakeStorage.beginWrite({ dataset, producer, inputs })

  await session.writeRows([{ id }])
  const { outcome: _outcome, ...version } = await session.commit()
  return version
}

/** raw_orders (sync) → staged_orders (pipeline) → orders_report (pipeline). */
async function seedChain() {
  const host = createHost()
  const raw = await commit(host, rawOrders, syncProducer)
  const staged = await commit(host, stagedOrders, stageProducer, [ref(raw)])
  const report = await commit(host, ordersReport, reportProducer, [ref(staged)])

  return { host, trusted: createTestSixb(host), raw, staged, report }
}

function readerIn(host: Host, groupIds: readonly string[]) {
  return createTestSixb(host, {
    authorization: resolveAuthorizationContext({
      principal: { type: "user", id: `user-${groupIds.join("-") || "none"}` },
      groupIds,
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })
}

function ref(version: DatasetVersion): DatasetVersionRef {
  return { datasetId: version.datasetId, versionId: version.versionId }
}

function node(version: DatasetVersion, producer: DatasetProducer) {
  return { ...ref(version), mode: version.mode, createdAt: version.createdAt, producer }
}

describe("dataset lineage", () => {
  test("walks a version's inputs upstream, nearest first", async () => {
    const { trusted, raw, staged, report } = await seedChain()

    const lineage = await trusted.datasets.lineage(ordersReport, { versionId: report.versionId })

    expect(lineage).toEqual({
      nodes: [node(report, reportProducer), node(staged, stageProducer), node(raw, syncProducer)],
      edges: [
        { from: ref(staged), to: ref(report) },
        { from: ref(raw), to: ref(staged) },
      ],
      restricted: 0,
      truncated: false,
    })
  })

  test("starts from the latest version by default and reports its parent", async () => {
    const { host, trusted, raw } = await seedChain()
    const appended = await host.lakeStorage.beginWrite({
      dataset: rawOrders,
      mode: "append",
      producer: syncProducer,
    })
    await appended.writeRows([{ id: "order-2" }])
    const latest = await appended.commit()

    const lineage = await trusted.datasets.lineage(rawOrders)

    expect(lineage?.nodes).toEqual([
      { ...node(latest, syncProducer), parentVersionId: raw.versionId },
    ])
  })

  // Guard proof: return `{ ...producer }` unconditionally from `visibleProducer` in
  // `datasets/lineage.ts` and the analyst and operator rows fail.
  test.each([
    ["trusted code", [], [reportProducer, stageProducer, syncProducer]],
    [
      "a dataset viewer",
      [analysts.id],
      [{ kind: "pipeline" }, { kind: "pipeline" }, { kind: "sync" }],
    ],
    ["an operator", [operators.id], [{ kind: "pipeline" }, stageProducer, syncProducer]],
  ] as const)("shows %s the producers whose runs it may view", async (_, groupIds, expected) => {
    const { host, trusted, report } = await seedChain()
    const reader = groupIds.length === 0 ? trusted : readerIn(host, groupIds)

    const lineage = await reader.datasets.lineage(ordersReport, { versionId: report.versionId })

    expect(lineage?.nodes.map((version) => "producer" in version && version.producer)).toEqual([
      ...expected,
    ])
  })

  test("reduces an ingest producer to its kind", async () => {
    const { host, trusted } = await seedChain()
    const ingested = await commit(host, rawOrders, { kind: "ingest", id: "execution-1" }, [], "x")

    const lineage = await trusted.datasets.lineage(rawOrders, { versionId: ingested.versionId })

    expect(lineage?.nodes).toEqual([node(ingested, { kind: "ingest" })])
  })

  // Guard proof: drop the `step > depth` condition in `walkDatasetLineage` and depth 1 walks the
  // whole chain.
  test.each([
    [1, 2, true],
    [2, 3, false],
    [undefined, 3, false],
  ] as const)("depth %p returns %p versions, truncated: %p", async (depth, count, truncated) => {
    const { trusted, report } = await seedChain()

    const lineage = await trusted.datasets.lineage(ordersReport, {
      versionId: report.versionId,
      ...(depth === undefined ? {} : { depth }),
    })

    expect(lineage?.nodes).toHaveLength(count)
    expect(lineage?.edges).toHaveLength(count - 1)
    expect(lineage?.truncated).toBe(truncated)
  })

  test.each([0, 21, 1.5, Number.NaN])("rejects depth %p", async (depth) => {
    const { trusted } = await seedChain()

    const error = await trusted.datasets.lineage(ordersReport, { depth }).catch((error) => error)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toStartWith(
      "[Sixb] Dataset lineage depth must be an integer between 1 and 20"
    )
  })

  // Guard proof: drop the node cap condition in `walkDatasetLineage` and every input is returned.
  test("stops at the node cap", async () => {
    const host = createHost()
    const inputs: DatasetVersionRef[] = []
    for (let index = 0; index < MAX_DATASET_LINEAGE_NODES; index++) {
      inputs.push(ref(await commit(host, rawOrders, syncProducer, [], `order-${index}`)))
    }
    const report = await commit(host, ordersReport, reportProducer, inputs)

    const lineage = await createTestSixb(host).datasets.lineage(ordersReport, {
      versionId: report.versionId,
    })

    expect(lineage?.nodes).toHaveLength(MAX_DATASET_LINEAGE_NODES)
    expect(lineage?.edges).toHaveLength(MAX_DATASET_LINEAGE_NODES - 1)
    expect(lineage?.truncated).toBe(true)
  })

  test("reports an input version the lake no longer holds as expired", async () => {
    const host = createHost()
    const expired = { datasetId: rawOrders.id, versionId: "ver_expired" }
    const staged = await commit(host, stagedOrders, stageProducer, [expired])

    const lineage = await createTestSixb(host).datasets.lineage(stagedOrders)

    expect(lineage).toEqual({
      nodes: [node(staged, stageProducer), { ...expired, expired: true }],
      edges: [{ from: expired, to: ref(staged) }],
      restricted: 0,
      truncated: false,
    })
  })

  // Guard proof: drop the `canViewDataset` check in `walkDatasetLineage` and the staged and raw
  // versions are returned.
  test("leaves out a version the reader cannot view, and everything upstream of it", async () => {
    const { host, staged, report } = await seedChain()

    const lineage = await readerIn(host, [reporters.id]).datasets.lineage(ordersReport, {
      versionId: report.versionId,
    })

    expect(lineage).toEqual({
      nodes: [node(report, { kind: "pipeline" })],
      edges: [],
      restricted: 1,
      truncated: false,
    })
    expect(JSON.stringify(lineage)).not.toContain(staged.versionId)
  })

  test("returns null for a version that does not exist or a reader who cannot view it", async () => {
    const { host, trusted, report } = await seedChain()
    const delegated = host.withScope(
      createSharedTestScope({
        projectId: host.id,
        requestId: "shared-request",
        correlationId: "shared-correlation",
        access: { grants: [] },
        delegation: { kind: "share", grantId: "share-grant", sessionId: "share-session" },
      })
    )
    const latest = { versionId: report.versionId }

    // Guard proof: drop the `allowed` check from `lineage` in `datasets/execution.ts` and the
    // outsider and delegated readers see the report's lineage.
    expect(await trusted.datasets.lineage(ordersReport, { versionId: "ver_missing" })).toBeNull()
    expect(await createTestSixb(createHost()).datasets.lineage(rawOrders)).toBeNull()
    expect(await readerIn(host, []).datasets.lineage(ordersReport, latest)).toBeNull()
    expect(await delegated.datasets.lineage(ordersReport, latest)).toBeNull()
  })
})

describe("dataset versions", () => {
  // Guard proof: return `version` unchanged from `readerVersion` in `datasets/execution.ts`; the
  // reporter then sees the pipeline run, the staged version and the column lineage.
  test("show their producer and inputs as far as the reader may see them", async () => {
    const { host, raw, staged, report } = await seedChain()
    const stored = await host.lakeStorage.getVersion(ordersReport.id, report.versionId)
    const storedRaw = await host.lakeStorage.getVersion(rawOrders.id, raw.versionId)
    const reporter = readerIn(host, [reporters.id])

    const analystVersion = await readerIn(host, [analysts.id]).datasets.getVersion(
      ordersReport,
      report.versionId
    )
    const reporterVersion = await reporter.datasets.getVersion(ordersReport, report.versionId)

    expect(stored).toMatchObject({ producer: reportProducer, inputs: [ref(staged)] })
    expect(analystVersion).toMatchObject({ producer: { kind: "pipeline" }, inputs: [ref(staged)] })
    const reporterView = {
      ...ref(report),
      mode: report.mode,
      createdAt: report.createdAt,
      schema: report.schema,
      producer: { kind: "pipeline" },
      inputs: [],
      rowCount: report.rowCount,
      ...(report.sizeBytes === undefined ? {} : { sizeBytes: report.sizeBytes }),
    } satisfies DatasetVersion
    expect(reporterVersion).toEqual(reporterView)
    expect(await reporter.datasets.listVersions(ordersReport)).toEqual([reporterView])
    expect((await reporter.datasets.readRows(ordersReport))?.version).toEqual(reporterView)

    // A sync's version records its own columns as their lineage; the reader is not given it.
    expect(storedRaw?.lineage).toBeDefined()
    expect(await reporter.datasets.getVersion(rawOrders, raw.versionId)).not.toHaveProperty(
      "lineage"
    )
  })

  test("return null for a missing version and refuse a reader who cannot view the dataset", async () => {
    const { host, trusted, report } = await seedChain()
    const outsider = readerIn(host, [])

    const refused = await outsider.datasets
      .getVersion(ordersReport, report.versionId)
      .catch((error) => error)

    expect(await trusted.datasets.getVersion(ordersReport, "ver_missing")).toBeNull()
    expect(refused).toBeInstanceOf(AuthorizationError)
    expect(
      await outsider.datasets.listVersions(ordersReport).catch((error) => error)
    ).toBeInstanceOf(AuthorizationError)
  })
})
