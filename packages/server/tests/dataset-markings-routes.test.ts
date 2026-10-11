import { describe, expect, test } from "bun:test"
import {
  can,
  change,
  col,
  defineDataset,
  defineGroup,
  defineMarking,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "dataset-markings-tests"
const financial = defineMarking("financial")

const rawInvoices = defineDataset("raw_invoices", {
  schema: [
    col("id", "string"),
    col("title", "string"),
    col("amount", "decimal", { markings: [financial] }),
  ],
  primaryKey: "id",
})
/** `SELECT id, title FROM raw_invoices WHERE amount > 100` */
const largeInvoices = defineDataset("large_invoices", {
  schema: [col("id", "string"), col("title", "string")],
})

const staff = defineGroup("staff")
const finance = defineGroup("finance")
const reader = defineRole("reader", {
  grantedTo: [staff, finance],
  grants: [can.view([rawInvoices, largeInvoices])],
})
const financeClearance = defineRole("finance-clearance", {
  grantedTo: [finance],
  clearances: [financial],
})

async function createApp() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    datasets: [rawInvoices, largeInvoices],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    markings: [financial],
    groups: [staff, finance],
    roles: [reader, financeClearance],
    auth: { id: "test", kind: "dev" },
  })
  await createTestSixb(host).datasets.ingest(rawInvoices, {
    changes: [change.upsert({ id: "inv-1", title: "July", amount: "120.00" })],
  })
  const raw = (column: string) => ({ datasetId: rawInvoices.id, column })
  await host.lakeStorage.createDataset(largeInvoices)
  const write = await host.lakeStorage.beginWrite({
    dataset: largeInvoices,
    mode: "snapshot",
    producer: { kind: "pipeline", id: "invoices", stepId: "large-invoices" },
    lineage: { rows: [raw("amount")], columns: { id: [raw("id")], title: [raw("title")] } },
  })
  await write.writeRows([{ id: "inv-1", title: "July" }])
  const { versionId } = await write.commit()
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  return { app, storage, versionId }
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
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-10-09T10:00:00.000Z"),
    expiresAt: new Date("2099-10-09T10:00:00.000Z"),
  })
  return { cookie: `sixb_session=${credential.cookieValue}` }
}

describe("dataset routes with markings", () => {
  test("rows omit marked columns and list them in redactions", async () => {
    const { app, storage } = await createApp()
    const staffHeaders = await seedSession(storage, "usr_staff", [staff.id])
    const financeHeaders = await seedSession(storage, "usr_finance", [finance.id])
    const rowsUrl = "http://localhost/api/datasets/raw_invoices/rows"

    const redacted = await app.fetch(new Request(rowsUrl, { headers: staffHeaders }))
    expect(redacted.status).toBe(200)
    expect(await redacted.json()).toMatchObject({
      columns: ["id", "title"],
      redactions: { amount: { reason: "missing_clearance" } },
      rows: [{ id: "inv-1", title: "July" }],
      count: 1,
    })

    // Asking for the marked column omits it, as a projected object property would be.
    const requested = await app.fetch(
      new Request(`${rowsUrl}?columns=amount`, { headers: staffHeaders })
    )
    expect(await requested.json()).toMatchObject({ columns: [], rows: [{}], count: 1 })

    const cleared = await app.fetch(new Request(rowsUrl, { headers: financeHeaders }))
    const body = await cleared.json()
    expect(body.columns).toEqual(["id", "title", "amount"])
    expect(body.rows).toEqual([{ id: "inv-1", title: "July", amount: "120.00" }])
    expect(body.redactions).toBeUndefined()
  })

  // Reproduce: drop assertRowsReadable from readRows in createDatasetsRuntime; the rows route
  // answers 200 with one empty row. Make describeVersion return the version unchanged; the
  // version routes and the catalog show its row count.
  test("a version whose rows a marked column selected hides its rows and their count", async () => {
    const { app, storage, versionId } = await createApp()
    const staffHeaders = await seedSession(storage, "usr_staff", [staff.id])
    const financeHeaders = await seedSession(storage, "usr_finance", [finance.id])
    const base = "http://localhost/api/datasets/large_invoices"
    const get = async (url: string, headers: { cookie: string }) => {
      const response = await app.fetch(new Request(url, { headers }))
      return { status: response.status, body: await response.json() }
    }

    const rows = await get(`${base}/rows`, staffHeaders)
    expect(rows.status).toBe(403)
    expect(rows.body.error).toBe(
      `[Sixb] Cannot read the rows of version '${versionId}' of dataset 'large_invoices': which rows it holds was decided by columns that require clearance for marking 'financial'.`
    )
    const versions = await get(`${base}/versions`, staffHeaders)
    expect(versions.body.versions.map((version: object) => "rowCount" in version)).toEqual([false])
    const version = await get(`${base}/versions/${versionId}`, staffHeaders)
    expect(version.body.versionId).toBe(versionId)
    expect(version.body.rowCount).toBeUndefined()
    expect(version.body.sizeBytes).toBeUndefined()
    const catalog = await get(base, staffHeaders)
    expect(catalog.body.latestVersion.versionId).toBe(versionId)
    expect(catalog.body.latestVersion.rowCount).toBeUndefined()
    const list = await get("http://localhost/api/datasets", staffHeaders)
    expect(
      list.body.map((item: { id: string; latestVersion: { rowCount?: number } }) => [
        item.id,
        item.latestVersion.rowCount,
      ])
    ).toEqual([
      ["raw_invoices", 1],
      ["large_invoices", undefined],
    ])

    expect((await get(`${base}/rows`, financeHeaders)).body).toMatchObject({
      rows: [{ id: "inv-1", title: "July" }],
      total: 1,
    })
    expect((await get(`${base}/versions/${versionId}`, financeHeaders)).body.rowCount).toBe(1)
    expect((await get(base, financeHeaders)).body.latestVersion.rowCount).toBe(1)
  })
})
