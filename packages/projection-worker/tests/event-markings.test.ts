import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import {
  type AuthorizationContext,
  can,
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
  defineGroup,
  defineMarking,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  resolveAuthorizationContext,
  SixbHost,
  type StoredDomainEvent,
} from "@sixb/core"
import { ProjectionRunDispatcher } from "@sixb/core/internal/projections"
import type { DatasetColumnLineage, DatasetVersion } from "@sixb/core/lake-storage"
import type { ProjectionRunRecord } from "@sixb/core/storage"
import { createTestSixb } from "@sixb/core/testing"
import { ProjectionWorker } from "../src"

// A step computed `title` from the marked `amount`, and `Invoice.title` declared the marking. The
// step is fixed and the marking removed; the pipeline reruns and the projection applies a version
// whose titles are real. Objects then hold real titles, but events still hold the amounts: in the
// `before` values the projection replaced, in the rows it deleted, and in what a user's edit
// recorded of the object. No event names the version those values came from.
//
// Pipeline versions are committed as the pipeline worker commits them (producer, inputs, lineage):
// the in-memory lake cannot analyze SQL.

const warn = spyOn(console, "warn").mockImplementation(() => {})
afterAll(() => warn.mockRestore())

const projectId = "event-markings"
const financial = defineMarking("financial")
const sales = defineGroup("sales")
const finance = defineGroup("finance")

const rawInvoices = defineDataset("raw_invoices", {
  schema: [
    col("id", "string"),
    col("title", "string"),
    col("amount", "decimal", { markings: [financial] }),
  ],
})

const invoices = defineDataset("invoices", {
  schema: [col("id", "string"), col("title", "string"), col("amount", "decimal")],
})

const normalize = definePipelineStep("normalize-invoices")
  .inputs({ invoices: rawInvoices })
  .output(invoices)
  .sql(({ invoices }) => `SELECT id, title, amount FROM ${invoices}`)

const RAW = [
  { id: "inv-1", title: "July maintenance", amount: "120" },
  { id: "inv-2", title: "Chiller retrofit", amount: "4500" },
]

/** What the first step computed from `amount`: no reader without `financial` may receive it. */
const AMOUNTS = new Set(RAW.map((row) => row.amount))

interface Shared {
  readonly storage: InMemoryStorage
  readonly lake: InMemoryLakeStorage
  readonly broker: InMemoryBroker
}

/** One deployment of the code over the storage, lake and broker every deployment shares. */
function deploy(shared: Shared, titleMarked: boolean) {
  const Invoice = defineObjectType({
    id: "Invoice",
    name: "Invoice",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("title", "string", titleMarked ? { markings: [financial] } : {}),
      prop("notes", "string"),
      prop("amount", "decimal", { markings: [financial] }),
    ],
  })

  const host = new SixbHost({
    id: projectId,
    ontology: [Invoice],
    markings: [financial],
    groups: [sales, finance],
    roles: [
      defineRole("invoice-reader", {
        grantedTo: [sales, finance],
        grants: [can.view([Invoice]), can.edit(Invoice)],
      }),
      defineRole("finance-clearance", { grantedTo: [finance], clearances: [financial] }),
    ],
    datasets: [rawInvoices, invoices],
    pipelines: [definePipeline("finance").then(normalize)],
    projections: [
      defineProjection("invoices", Invoice)
        .fromDataset(invoices)
        .properties({ id: "id", title: "title", amount: "amount" }),
    ],
    broker: shared.broker,
    storage: shared.storage,
    lakeStorage: shared.lake,
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })

  const reader = (groupId: string): AuthorizationContext =>
    resolveAuthorizationContext({
      principal: { type: "user", id: `user-${groupId}` },
      groupIds: [groupId],
      roles: host.definitions.security.listResolvedRoles(),
    })

  return {
    host,
    Invoice,
    sales: createTestSixb(host, { authorization: reader("sales") }),
    finance: createTestSixb(host, { authorization: reader("finance") }),
  }
}

type Deployment = ReturnType<typeof deploy>

/** A raw sync, then the `invoices` version the step computed from it. */
async function runPipeline(
  lake: InMemoryLakeStorage,
  raw: readonly DatasetRow[],
  output: readonly DatasetRow[],
  titleFrom: "title" | "amount"
): Promise<DatasetVersion> {
  const rawVersion = await commit(lake, rawInvoices, raw, {
    producer: { kind: "sync", id: "erp" },
  })

  const from = (column: string) => [{ datasetId: rawInvoices.id, column }]
  return commit(lake, invoices, output, {
    producer: { kind: "pipeline", id: "finance", stepId: "normalize-invoices" },
    inputs: [{ datasetId: rawVersion.datasetId, versionId: rawVersion.versionId }],
    lineage: {
      rows: [],
      columns: { id: from("id"), title: from(titleFrom), amount: from("amount") },
    },
  })
}

async function commit(
  lake: InMemoryLakeStorage,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[],
  write: {
    readonly producer:
      | { readonly kind: "sync"; readonly id: string }
      | { readonly kind: "pipeline"; readonly id: string; readonly stepId: string }
    readonly inputs?: { readonly datasetId: string; readonly versionId: string }[]
    readonly lineage?: DatasetColumnLineage
  }
): Promise<DatasetVersion> {
  await lake.createDataset(dataset)
  const writer = await lake.beginWrite({ dataset, mode: "snapshot", ...write })
  await writer.writeRows(rows)
  const { outcome: _outcome, ...version } = await writer.commit({ commitMessage: dataset.id })
  return version
}

async function project(app: Deployment, version: DatasetVersion): Promise<ProjectionRunRecord> {
  const { runId } = await new ProjectionRunDispatcher(app.host).dispatch({
    projectionId: "invoices",
    datasetVersion: {
      datasetId: version.datasetId,
      versionId: version.versionId,
      createdAt: version.createdAt.toISOString(),
    },
  })

  const worker = new ProjectionWorker(app.host)
  await worker.start()
  try {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 5_000) {
      const run = await app.host.storage.projectionRuns?.getById({ projectId, id: runId })
      if (run?.status === "succeeded" || run?.status === "failed") return run
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    throw new Error(`[Test] Projection run '${runId}' did not settle.`)
  } finally {
    await worker.stop()
  }
}

/** Each place an amount appears in the payload of an object event, by path. */
function amountsIn(events: readonly StoredDomainEvent[]): string[] {
  const found: string[] = []
  const visit = (value: unknown, path: string) => {
    if (typeof value === "string" && AMOUNTS.has(value)) found.push(path)
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`)
    }
  }

  for (const event of events) {
    if (event.topic === "objects") visit(event.payload, `${event.type}:${event.payload.primaryId}`)
  }
  return found
}

describe("events keep the markings of the versions their values came from", () => {
  let app: Deployment
  let stored: readonly StoredDomainEvent[]
  let fixed: DatasetVersion

  beforeAll(async () => {
    const shared = {
      storage: new InMemoryStorage(),
      lake: new InMemoryLakeStorage(),
      broker: new InMemoryBroker(),
    }

    // Day 1: titles are computed from amounts and the code marks them. A user edits a note.
    const dayOne = deploy(shared, true)
    const leaking = await runPipeline(
      shared.lake,
      RAW,
      RAW.map((row) => ({ ...row, title: row.amount })),
      "amount"
    )
    expect((await project(dayOne, leaking)).status).toBe("succeeded")

    await shared.storage.auth?.users.create({ projectId, id: "user-finance", email: "f@x.test" })
    await dayOne.finance.objects.upsert(dayOne.Invoice.id, { id: "inv-1", notes: "Checked" })

    // Day 2: the step is fixed and the marking removed. Day 3: the pipeline reruns without inv-2
    // and with a new inv-3, and the projection applies the fixed version.
    app = deploy(shared, false)
    const dayThree = [RAW[0]!, { id: "inv-3", title: "Pump service", amount: "75" }]
    fixed = await runPipeline(shared.lake, dayThree, dayThree, "title")
    expect((await project(app, fixed)).status).toBe("succeeded")

    stored = await app.host.events.read()
  })

  const fromFixedVersion = (type: StoredDomainEvent["type"], primaryId: string) => {
    const event = stored.find(
      (candidate) =>
        candidate.type === type &&
        candidate.origin?.kind === "projection" &&
        candidate.origin.datasetVersionId === fixed.versionId &&
        candidate.topic === "objects" &&
        candidate.payload.primaryId === primaryId
    )
    if (!event) throw new Error(`[Test] No ${type} event for '${primaryId}'.`)
    return event
  }

  test("objects hold the real titles", async () => {
    const invoice = await app.sales.objects.get(app.Invoice.id, "inv-1")
    expect(invoice?.properties.title).toBe("July maintenance")
  })

  // Reproduce: in events/execution.ts, return `earlier: false` from `eventSources` for every event;
  // the update delivers `propertyChanges.title.before`, the deletion `propertyChanges.title.before`
  // and the user's edit `properties.title`, each an amount.
  test("an update the fixed version applied does not deliver the title it replaced", async () => {
    const [update] = await app.sales.events.visible([fromFixedVersion("object.updated", "inv-1")])
    expect(amountsIn([update!])).toEqual([])
    expect(update?.topic === "objects" && update.payload.redactions).toHaveProperty("title")
  })

  test("an object the fixed version created delivers its own title", async () => {
    const [created] = await app.sales.events.visible([fromFixedVersion("object.created", "inv-3")])
    expect(created?.type === "object.created" && created.payload.properties).toEqual({
      id: "inv-3",
      title: "Pump service",
    })
  })

  test("a row the fixed version deleted does not deliver its values", async () => {
    const [deleted] = await app.sales.events.visible([fromFixedVersion("object.deleted", "inv-2")])
    expect(amountsIn([deleted!])).toEqual([])
  })

  test("a user's edit does not deliver the projected values it recorded", async () => {
    const edit = stored.find(
      (event) =>
        event.type === "object.updated" &&
        event.origin?.kind !== "projection" &&
        event.payload.primaryId === "inv-1"
    )
    if (!edit) throw new Error("[Test] The user's edit was not recorded.")

    const [delivered] = await app.sales.events.visible([edit])
    expect(amountsIn([delivered!])).toEqual([])
    expect(delivered?.type === "object.updated" && delivered.payload.properties).toMatchObject({
      notes: "Checked",
    })
  })

  test("no event a reader without the marking reads holds an amount", async () => {
    expect(amountsIn(await app.sales.events.read())).toEqual([])
  })

  test("a reader with the marking reads every value", async () => {
    const read = await app.finance.events.read()
    expect(read).toHaveLength(stored.length)
    expect(amountsIn(read).length).toBeGreaterThan(0)

    const [update] = await app.finance.events.visible([fromFixedVersion("object.updated", "inv-1")])
    expect(update?.topic === "objects" && update.payload).toMatchObject({
      propertyChanges: { title: { before: "120", after: "July maintenance" } },
    })
  })
})
