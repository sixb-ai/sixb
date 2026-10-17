import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, type DatasetVersion, InMemoryStorage, type SixbHost } from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { ProjectionRunDispatcher } from "@sixb/core/internal/projections"
import { createTestSixb } from "@sixb/core/testing"
import { PipelineWorker } from "@sixb/pipeline-worker"
import { ProjectionWorker } from "@sixb/projection-worker"
import { createSixbApi, SixbServer } from "../../server/src/server"
import {
  readAppliedMarkingNotices,
  startOrchestratorRuntime,
  startSixbRuntime,
} from "../src/lib/runtime"
import {
  createPipelineMarkingsProject,
  finance,
  invoiceAudit,
  invoiceTitles,
  type PipelineMarkingsProjectOptions,
  peopleOps,
  rawAlarms,
  rawContracts,
  rawCustomers,
  rawEmployees,
  rawEquipment,
  rawFxRates,
  rawInvoices,
  rawPayments,
  rawReadings,
  staff,
} from "./fixtures/shared/createPipelineMarkingsProject"

// Security markings through pipelines, end to end: a DuckLake lake on local files, the pipeline,
// projection and orchestrator workers `sixb dev` runs, and the HTTP API read by signed-in users.
//
// It proves that the SQL preflight stops a misdeclared project before it serves; that each reader
// receives exactly the columns and properties their clearances allow, whatever SQL and TypeScript
// steps computed them; that a version keeps the markings of the code that wrote it through edits,
// appends, schema changes and a restart; and that a projection refuses a version that would leak.
//
// Each test is one deployment of the same project over the same lake, so they run in order.

const DEPLOY_TIMEOUT_MS = 45_000
const WAIT_TIMEOUT_MS = 20_000

/** The markings each column should carry once every pipeline has run once. */
const COLUMN_MARKINGS: Record<string, Record<string, readonly string[]>> = {
  raw_customers: { name: ["pii"], tax_id: ["pii"] },
  raw_invoices: { amount: ["financial"] },
  raw_payments: { paid_amount: ["financial"] },
  raw_employees: { name: ["pii"], salary: ["hr"] },
  raw_contracts: { monthly_fee: ["financial"] },
  raw_fx_rates: {},
  invoices_normalized: { amount: ["financial"] },
  invoice_reconciliation: {
    amount_eur: ["financial"],
    paid_eur: ["financial"],
    status: ["financial"],
  },
  // Filtered on the amount: every column reveals it.
  large_invoices: { invoice_id: ["financial"], customer_id: ["financial"] },
  // A TypeScript step that reads every reconciliation column.
  customer_revenue: { customer_id: ["financial"], invoices: ["financial"] },
  // A TypeScript step that picks the id and the title only.
  invoice_titles: {},
  invoice_audit: {},
  customer_360: { display_name: ["pii"] },
  org_chart: { name: ["pii"] },
  team_payroll: { total_salary: ["hr"] },
  employee_directory: {},
  equipment_status: {},
  alarm_context: { monthly_fee: ["financial"] },
}

const PROPERTY_MARKINGS: Record<string, Record<string, readonly string[]>> = {
  Customer: { displayName: ["pii"] },
  Invoice: { amount: ["financial"] },
  Receivable: { amountEur: ["financial"], paidEur: ["financial"], status: ["financial"] },
  Team: { totalSalary: ["hr"] },
  Employee: { name: ["pii"] },
  Equipment: {},
  Alarm: { monthlyFee: ["financial"] },
}

const READERS = {
  staff: { groupId: staff.id, clearances: [] as string[] },
  finance: { groupId: finance.id, clearances: ["financial"] },
  peopleOps: { groupId: peopleOps.id, clearances: ["financial", "hr", "pii"] },
}
type Reader = keyof typeof READERS

let lakeDir: string
const storage = new InMemoryStorage()
const reported: string[] = []
const cookies = new Map<Reader, string>()

beforeAll(async () => {
  lakeDir = await mkdtemp(join(tmpdir(), "sixb-pipeline-markings-"))
  for (const [reader, { groupId }] of Object.entries(READERS) as [Reader, { groupId: string }][]) {
    cookies.set(reader, await signIn(reader, groupId))
  }
})

afterAll(async () => {
  await rm(lakeDir, { recursive: true, force: true })
})

describe("security markings through pipelines (e2e)", () => {
  // Reproduce: drop checkRuntimePipelineMarkings from startSixbRuntime; the runtime starts.
  test(
    "the preflight stops a project whose SQL derives markings it does not declare",
    async () => {
      const customerNamePii = await startupFailure({ customerNamePii: false })
      expect(customerNamePii).toBe(
        "[Sixb] Projection 'customers': property 'Customer.displayName' is projected from column 'customer_360.display_name', which carries [pii] from 'raw_customers.name' through step 'customers/customer-360'. Add markings: [pii] to the property."
      )

      expect(await startupFailure({ paymentPivot: true })).toBe(
        "[Sixb] Pipeline 'payment-pivots' step 'payment-pivot' reads column 'raw_payments.paid_amount', which carries [financial], but its SQL cannot be analyzed: PIVOT is not supported. Rewrite that part of the query, or pick only unmarked columns."
      )

      expect(await startupFailure({ withoutSqlAnalysis: true })).toBe(
        "[Sixb] Pipeline 'finance' step 'normalize-invoices' reads column 'raw_invoices.amount', which carries [financial], but the lake provider cannot analyze SQL to derive the markings of its output. Use a lake provider that analyzes SQL, or pick only unmarked columns."
      )

      // The API refuses to serve the same project.
      const host = project({ customerNamePii: false })
      const server = new SixbServer({ host, quiet: true, port: 0, browser: BROWSER })
      await expect(server.start()).rejects.toThrow(customerNamePii)
      await host.lakeStorage.close?.()
    },
    DEPLOY_TIMEOUT_MS
  )

  test(
    "every reader receives exactly what their clearances allow",
    async () => {
      const app = await deploy()
      await seedSources(app.host)
      await app.run("finance")
      await Promise.all(["audit", "customers", "hr", "field-service"].map(app.run))
      await app.projected()

      const expected = expectedRedactions()
      expect(await datasetRedactions(app.host)).toEqual(expected.datasets)
      expect(await objectRedactions(app.host)).toEqual(expected.objects)

      // Asking for a marked column by name omits it all the same.
      const requested = await readRows(app.host, "staff", "invoices_normalized", {
        columns: "amount",
      })
      expect(requested).toMatchObject({ columns: [], redactions: { amount: {} } })
      expect(requested.rows).toEqual([{}, {}, {}, {}])

      // Linked objects are redacted like any other read; filtering by a marked property is not
      // allowed.
      const links = await post(app.host, "staff", "/api/objects/query/links", {
        query: { kind: "start", objectTypeId: "Invoice" },
        direction: "outgoing",
        includeObjects: true,
      })
      const customer = links.body.objects.find(
        (object: { objectTypeId: string }) => object.objectTypeId === "Customer"
      )
      expect(customer.redactions).toEqual({ displayName: { reason: "missing_clearance" } })

      const filter = await post(app.host, "staff", "/api/objects/query", {
        query: {
          kind: "filter",
          input: { kind: "start", objectTypeId: "Receivable" },
          predicate: { op: "eq", propertyId: "status", value: "paid" },
        },
      })
      expect(filter).toEqual({
        status: 403,
        body: {
          error:
            "[Sixb] Cannot filter by 'Receivable.status' at '$.predicate': it requires clearance for marking 'financial'.",
        },
      })

      // Trusted code reads every column.
      const trusted = await createTestSixb(app.host).datasets.readRows(invoiceTitles, {})
      expect(trusted?.redactions).toBeUndefined()

      await app.stop()
    },
    DEPLOY_TIMEOUT_MS
  )

  // Reproduce: remove validatePinnedMarkings from validateProjectionJob; the leaking version
  // projects. This test and the one without lineage fail.
  test(
    "a projection refuses a version that leaks, and projects the version its fix writes",
    async () => {
      // Workers deployed ahead of the API run the edited step: its titles now depend on the
      // amount, which `Invoice.title` does not declare. Worker roles run no preflight.
      const leaking = await deploy({ invoiceTitle: "amount" }, "workers")
      const invoicesBefore = await listObjects(leaking.host, "finance", "Invoice")

      const leaked = (await leaking.run("finance")).version("normalize-invoices")
      const refused = await leaking.projection("invoices", leaked)
      expect(refused.status).toBe("failed")
      expect(refused.error).toMatchObject({
        code: "projection.execution_failed",
        retryable: false,
        message: `Projection execution failed. [Sixb] Projection 'invoices' cannot read version '${leaked.versionId}' of dataset 'invoices_normalized': property 'Invoice.title' is projected from column 'invoices_normalized.title', which carries [financial] in this version. Add markings: [financial] to the property. If the code that writes 'invoices_normalized' no longer derives these markings, rerun its pipeline.`,
      })
      expect(reported).toContain(refused.error?.message ?? "")
      expect(await listObjects(leaking.host, "finance", "Invoice")).toEqual(invoicesBefore)

      // Downstream of the leak, only what read the title is marked.
      expect(await redacted(leaking.host, "staff", "invoices_normalized")).toEqual([
        "amount",
        "title",
      ])
      expect(await redacted(leaking.host, "staff", "invoice_titles")).toEqual([
        "invoice_id",
        "title_upper",
      ])
      expect(await redacted(leaking.host, "staff", "invoice_reconciliation")).toEqual([
        "amount_eur",
        "paid_eur",
        "status",
      ])

      await leaking.stop()

      // The fix writes the same rows under new lineage: a new version, which projects.
      const fixed = await deploy()
      const fix = (await fixed.run("finance")).version("normalize-invoices")
      expect(fix.versionId).not.toBe(leaked.versionId)
      expect(await trustedRows(fixed.host, fix)).toEqual(await trustedRows(fixed.host, leaked))
      expect((await fixed.projection("invoices", fix)).status).toBe("succeeded")

      expect(await redacted(fixed.host, "staff", "invoices_normalized")).toEqual(["amount"])
      expect(await redacted(fixed.host, "staff", "invoice_titles")).toEqual([])

      // The version the edited step wrote keeps its markings.
      expect(await redacted(fixed.host, "staff", "invoices_normalized", leaked)).toEqual([
        "amount",
        "title",
      ])

      await fixed.stop()
    },
    DEPLOY_TIMEOUT_MS
  )

  // Reproduce: pass no appliedMarkings to createAuthorizedObjectReader in SixbHost.withScope;
  // staff reads the titles on day 2. Drop onProjectionApplied there instead; day 3 still hides
  // them, since these hosts refresh every ten minutes.
  test(
    "objects keep the markings of the version they were projected from until a fix applies",
    async () => {
      // Day 1: titles are computed from amounts, and `Invoice.title` declares it.
      const dayOne = await deploy({ invoiceTitle: "amount", invoiceTitleFinancial: true })
      const computed = (await dayOne.run("finance")).version("normalize-invoices")
      expect((await dayOne.projection("invoices", computed)).status).toBe("succeeded")
      await dayOne.stop()

      // Day 2: the SQL is fixed and the marking removed. The code passes the preflight, but the
      // objects still hold what day 1 projected.
      const dayTwo = await deploy()
      const invoices = await listObjects(dayTwo.host, "staff", "Invoice")
      expect(invoices.length).toBeGreaterThan(0)

      for (const invoice of invoices) {
        expect(invoice.properties.title).toBeUndefined()
        expect(Object.keys(invoice.redactions ?? {}).sort()).toEqual(["amount", "title"])
      }

      const byTitle = {
        query: {
          kind: "filter",
          input: { kind: "start", objectTypeId: "Invoice" },
          predicate: { op: "eq", propertyId: "title", value: "Filter swap" },
        },
      }
      expect(await post(dayTwo.host, "staff", "/api/objects/query", byTitle)).toEqual({
        status: 403,
        body: {
          error:
            "[Sixb] Cannot filter by 'Invoice.title' at '$.predicate': it requires clearance for marking 'financial'.",
        },
      })

      expect((await listObjects(dayTwo.host, "finance", "Invoice"))[0]?.redactions).toBeUndefined()

      // What `sixb check` and `sixb lake check` report.
      expect(await readAppliedMarkingNotices(dayTwo.host)).toEqual([
        `[Sixb] Projection 'invoices' applied version '${computed.versionId}' of 'invoices_normalized', in which property 'Invoice.title' is projected from column 'invoices_normalized.title', which carries [financial]. 'Invoice.title' keeps these markings until the projection applies a version the code allows. Rerun pipeline 'finance' to replace it.`,
      ])

      // Day 3: the pipeline reruns and the projection applies its version. This process applied
      // it, so the next read sees it.
      const fixed = (await dayTwo.run("finance")).version("normalize-invoices")
      expect((await dayTwo.projection("invoices", fixed)).status).toBe("succeeded")

      const titles = (await listObjects(dayTwo.host, "staff", "Invoice")).map((invoice) => ({
        title: invoice.properties.title,
        redactions: Object.keys(invoice.redactions ?? {}),
      }))
      expect(titles).toContainEqual({ title: "Filter swap", redactions: ["amount"] })
      expect(titles.every(({ title }) => typeof title === "string")).toBe(true)
      expect((await post(dayTwo.host, "staff", "/api/objects/query", byTitle)).status).toBe(200)
      expect(await readAppliedMarkingNotices(dayTwo.host)).toEqual([])

      await dayTwo.stop()
    },
    DEPLOY_TIMEOUT_MS
  )

  // Reproduce: classify every version as a snapshot in createDatasetVersionMarkings; the earlier
  // rows lose their markings. This test and the schema change fail.
  test(
    "an append keeps the markings of the rows it appended before a fix",
    async () => {
      const quoting = await deploy({ auditNote: "amount" })
      await ingestInvoice(quoting.host, "inv-5")
      const quoted = (await quoting.run("audit")).version("audit-invoices")
      expect(quoted.mode).toBe("append")
      await quoting.stop()

      const fixed = await deploy()
      await ingestInvoice(fixed.host, "inv-6")
      const appended = (await fixed.run("audit")).version("audit-invoices")
      expect(appended.parentVersionId).toBe(quoted.versionId)

      // Its own rows only quote titles, but it keeps the earlier rows that quote amounts, and
      // records both.
      expect(quoted.lineage).toMatchObject({
        columns: {
          note: [
            { datasetId: "raw_invoices", column: "amount" },
            { datasetId: "raw_invoices", column: "title" },
          ],
        },
      })
      expect(appended.lineage).toMatchObject({
        columns: {
          note: [
            { datasetId: "raw_invoices", column: "amount" },
            { datasetId: "raw_invoices", column: "title" },
          ],
        },
      })

      expect(await redacted(fixed.host, "staff", "invoice_audit")).toEqual(["note"])
      expect(await redacted(fixed.host, "finance", "invoice_audit")).toEqual([])
      await fixed.stop()
    },
    DEPLOY_TIMEOUT_MS
  )

  test(
    "a schema change keeps the markings the columns derive",
    async () => {
      const app = await deploy({ invoiceDueDate: true })
      const evolved = (await app.run("finance")).version("normalize-invoices")
      const versions = await app.host.lakeStorage.listVersions("invoices_normalized", 10)
      const schemaChange = versions.find((version) => version.mode === "schema")
      expect(schemaChange?.parentVersionId).toBeDefined()

      // `amount` is not declared on `invoices_normalized`: it derives from `raw_invoices.amount`.
      for (const version of [schemaChange, evolved]) {
        const rows = await readRows(app.host, "staff", "invoices_normalized", {
          versionId: version?.versionId,
        })
        expect(Object.keys(rows.redactions)).toEqual(["amount"])
        expect(rows.columns).toContain("due_at")
      }

      expect((await app.projection("invoices", evolved)).status).toBe("succeeded")
      await app.stop()
    },
    DEPLOY_TIMEOUT_MS
  )

  test(
    "a version without lineage over marked inputs is refused until its pipeline reruns",
    async () => {
      const app = await deploy({ invoiceDueDate: true })
      const legacy = await writeLegacyVersion(app.host)

      const refused = await app.projectVersion("invoices", legacy)
      expect(refused.status).toBe("failed")
      expect(refused.error?.message).toContain(
        `column 'invoices_normalized.invoice_id' becomes the id of 'Invoice' and cannot carry markings, but carries [financial, hr, pii] in this version. The version was classified with every marking its sources could hold, because version '${legacy.versionId}' of 'invoices_normalized' recorded no column lineage.`
      )
      expect(await redacted(app.host, "staff", "invoices_normalized", legacy)).toEqual([
        "amount",
        "channel",
        "currency",
        "customer_id",
        "due_at",
        "invoice_id",
        "issued_at",
        "title",
      ])

      const rerun = (await app.run("finance")).version("normalize-invoices")
      expect(rerun.versionId).not.toBe(legacy.versionId)
      expect((await app.projection("invoices", rerun)).status).toBe("succeeded")
      await app.stop()
    },
    DEPLOY_TIMEOUT_MS
  )

  test(
    "a restarted host classifies every version as before",
    async () => {
      // One host resolves each version after the ones it depends on, as they were written.
      const running = await deploy({ invoiceDueDate: true })
      const before = await historyRedactions(running.host, "oldest first")
      await running.stop()

      // A new host over the same lake starts from the newest versions, with nothing resolved.
      const restarted = await deploy({ invoiceDueDate: true })
      expect(await historyRedactions(restarted.host, "newest first")).toEqual(before)
      await restarted.stop()

      // The history holds what the earlier tests wrote, not only unmarked versions.
      expect(Object.values(before)).toContainEqual(["amount", "title"])
      expect(Object.values(before)).toContainEqual(["note"])
    },
    DEPLOY_TIMEOUT_MS
  )
})

// ── Deployments ─────────────────────────────────────────────

const BROWSER = {
  publicOrigin: "http://api.localhost",
  allowedOrigins: [{ origin: "http://atlas.localhost", audience: "atlas" as const }],
}

function project(options: Partial<PipelineMarkingsProjectOptions> = {}): SixbHost {
  const host = createPipelineMarkingsProject({
    lakeDir,
    storage,
    onError: (_error, context) => {
      if ("failure" in context) reported.push(context.failure.message)
    },
    ...options,
  })
  return host
}

async function startupFailure(options: Partial<PipelineMarkingsProjectOptions>): Promise<string> {
  const host = project(options)

  // A failed start closes the providers it opened.
  const error = await startSixbRuntime(host, { cohostWorkers: true }).then(
    () => null,
    (cause: unknown) => cause
  )

  if (!(error instanceof Error)) throw new Error("[Test] The runtime started.")
  return error.message
}

/**
 * Start the project as `sixb dev` does, or as worker roles do: the pipeline, projection and
 * orchestrator workers alone, without the preflight.
 */
async function deploy(
  options: Partial<PipelineMarkingsProjectOptions> = {},
  role: "dev" | "workers" = "dev"
) {
  const host = project(options)
  let stop: () => Promise<void>

  if (role === "dev") {
    const runtime = await startSixbRuntime(host, {
      cohostWorkers: true,
      workerConcurrency: { pipeline: 4, projection: 4 },
    })
    stop = () => runtime.stop()
  } else {
    const projections = new ProjectionWorker(host, { concurrency: 4 })
    const pipelines = new PipelineWorker(host)

    await projections.start()
    await pipelines.start()
    const orchestrator = await startOrchestratorRuntime(host)

    stop = async () => {
      await orchestrator.stop()
      await pipelines.stop()
      await projections.stop()
      await host.lakeStorage.close?.()
    }
  }

  return {
    host,
    stop,
    /** Run a pipeline to success, then read the version one of its steps wrote. */
    async run(pipelineId: string) {
      const pipelineRuns = host.storage.pipelineRuns
      if (!pipelineRuns) throw new Error("[Test] The storage keeps no pipeline runs.")

      const { runId } = await createTestSixb(host).pipelines.request({ pipelineId })
      const run = await waitFor(`pipeline '${pipelineId}'`, async () => {
        const found = await pipelineRuns.getById({ projectId: host.id, id: runId })
        return found?.status === "succeeded" || found?.status === "failed" ? found : null
      })
      expect(run).toMatchObject({ status: "succeeded" })

      const { steps } = await pipelineRuns.listSteps({ projectId: host.id, pipelineRunId: runId })
      const versions = new Map<string, DatasetVersion>()

      for (const { stepId, output } of steps) {
        const version =
          output && (await host.lakeStorage.getVersion(output.datasetId, output.versionId))
        if (version) versions.set(stepId, version)
      }

      return {
        version(stepId: string): DatasetVersion {
          const version = versions.get(stepId)
          if (!version) throw new Error(`[Test] Step '${stepId}' wrote no version.`)
          return version
        },
      }
    },
    /** The settled run of a projection over one version. */
    projection: (projectionId: string, version: DatasetVersion) =>
      settledProjection(host, projectionId, version),
    /** Dispatch a projection over a version, as the orchestrator does for each new one. */
    async projectVersion(projectionId: string, version: DatasetVersion) {
      await new ProjectionRunDispatcher(host).dispatch({
        projectionId,
        datasetVersion: {
          datasetId: version.datasetId,
          versionId: version.versionId,
          createdAt: version.createdAt.toISOString(),
        },
      })
      return settledProjection(host, projectionId, version)
    },
    /** Wait until every projection read the latest version of its dataset. */
    async projected() {
      for (const projection of host.definitions.projections.list()) {
        const latest = await host.lakeStorage.getLatestVersion(projection.datasetId)
        if (!latest) throw new Error(`[Test] '${projection.datasetId}' has no version.`)

        const run = await settledProjection(host, projection.id, latest)
        expect({ projection: projection.id, status: run.status }).toEqual({
          projection: projection.id,
          status: "succeeded",
        })
      }
    },
  }
}

async function settledProjection(host: SixbHost, projectionId: string, version: DatasetVersion) {
  return waitFor(`projection '${projectionId}' of '${version.versionId}'`, async () => {
    const { runs } = await host.storage.projectionRuns!.list({
      projectId: host.id,
      projectionId,
      datasetVersionId: version.versionId,
    })
    return runs.find((run) => run.status === "succeeded" || run.status === "failed") ?? null
  })
}

async function waitFor<T>(what: string, poll: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS

  for (;;) {
    const value = await poll()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`[Test] Timed out waiting for ${what}.`)

    await Bun.sleep(25)
  }
}

// ── Data ────────────────────────────────────────────────────

async function seedSources(host: SixbHost) {
  const sixb = createTestSixb(host)
  const ingest = (dataset: Parameters<typeof sixb.datasets.ingest>[0], rows: object[]) =>
    sixb.datasets.ingest(dataset, {
      changes: rows.map((row) => change.upsert(row as Record<string, unknown>)),
    })
  const at = (day: string) => `2026-${day}T10:00:00.000Z`

  await ingest(rawCustomers, [
    { customer_id: "c1", name: "Alpine Bakery", country: "fr", tax_id: "FR-1" },
    { customer_id: "c2", name: "Northwind Labs", country: "de", tax_id: "DE-2" },
    { customer_id: "c3", name: " ", country: "us", tax_id: "US-3" },
  ])
  await ingest(rawInvoices, [
    invoice("inv-1", "c1", " Boiler maintenance ", "120000", "cents", "eur", at("03-01"), "portal"),
    invoice("inv-2", "c1", "Filter swap", "300", "units", "eur", at("04-01"), "email"),
    invoice("inv-3", "c2", "Chiller retrofit", "5000", "units", "usd", at("07-01")),
    invoice("inv-4", "c3", "Energy audit", "80", "units", "gbp", at("05-01"), "portal"),
  ])
  await ingest(rawPayments, [
    { payment_id: "pay-1", invoice_id: "inv-1", paid_amount: "1200", paid_at: at("03-10") },
    { payment_id: "pay-2", invoice_id: "inv-3", paid_amount: "2000", paid_at: at("07-10") },
  ])
  await ingest(rawFxRates, [
    { rate_id: "fx-1", currency: "EUR", rate_to_eur: "1", valid_from: at("01-01") },
    { rate_id: "fx-2", currency: "USD", rate_to_eur: "0.9", valid_from: at("01-01") },
    { rate_id: "fx-3", currency: "USD", rate_to_eur: "0.95", valid_from: at("06-01") },
    { rate_id: "fx-4", currency: "GBP", rate_to_eur: "1.15", valid_from: at("01-01") },
  ])
  await ingest(rawEmployees, [
    { employee_id: "e1", name: "Dana Root", team: "exec", manager_id: null, salary: "200000" },
    { employee_id: "e2", name: "Sam Ops", team: "ops", manager_id: "e1", salary: "120000" },
    { employee_id: "e3", name: "Lee Tech", team: "ops", manager_id: "e2", salary: "60000" },
    { employee_id: "e4", name: "Kim Ledger", team: "finance", manager_id: "e1", salary: "90000" },
  ])
  await ingest(rawEquipment, [
    { equipment_id: "eq1", facility_id: "f1" },
    { equipment_id: "eq2", facility_id: "f2" },
  ])
  await ingest(rawReadings, [
    reading("r1", "eq1", "supply_temp", 68, "F", at("07-01")),
    reading("r2", "eq1", "supply_temp", 59, "F", at("07-02")),
    reading("r3", "eq1", "current", 2.5, "A", at("07-02")),
    reading("r4", "eq2", "supply_temp", 12, "C", at("07-01")),
    reading("r5", "eq2", "current", 1800, "mA", at("07-01")),
  ])
  await ingest(rawAlarms, [
    { alarm_id: "a1", equipment_id: "eq1", severity: "high" },
    { alarm_id: "a2", equipment_id: "eq2", severity: "low" },
  ])
  await ingest(rawContracts, [
    {
      contract_id: "k1",
      facility_id: "f1",
      tier: "silver",
      monthly_fee: "300",
      starts_at: at("01-01"),
    },
    {
      contract_id: "k2",
      facility_id: "f1",
      tier: "gold",
      monthly_fee: "450",
      starts_at: at("02-01"),
    },
    {
      contract_id: "k3",
      facility_id: "f2",
      tier: "bronze",
      monthly_fee: "150",
      starts_at: at("01-01"),
    },
  ])

  // An append step that reads its own output needs a first version of it.
  await host.lakeStorage.createDataset(invoiceAudit)
  const audit = await host.lakeStorage.beginWrite({ dataset: invoiceAudit, mode: "snapshot" })
  await audit.writeRows([])
  await audit.commit({ commitMessage: "start the invoice audit" })
}

function invoice(
  invoice_id: string,
  customer_id: string,
  title: string,
  amount: string,
  amount_unit: string,
  currency: string,
  issued_at: string,
  channel?: string
) {
  const payload = channel ? { channel } : {}
  return { invoice_id, customer_id, title, amount, amount_unit, currency, issued_at, payload }
}

function reading(
  reading_id: string,
  equipment_id: string,
  metric: string,
  value: number,
  unit: string,
  observed_at: string
) {
  return { reading_id, equipment_id, metric, value, unit, observed_at }
}

async function ingestInvoice(host: SixbHost, invoiceId: string) {
  await createTestSixb(host).datasets.ingest(rawInvoices, {
    changes: [
      change.upsert(
        invoice(
          invoiceId,
          "c2",
          `Visit ${invoiceId}`,
          "90",
          "units",
          "eur",
          "2026-08-01T10:00:00.000Z"
        )
      ),
    ],
  })
}

/** A pipeline version written before Sixb recorded lineage: its producer names no columns. */
async function writeLegacyVersion(host: SixbHost): Promise<DatasetVersion> {
  const dataset = host.definitions.datasets.getById("invoices_normalized")
  const raw = await host.lakeStorage.getLatestVersion(rawInvoices.id)
  const current = await host.lakeStorage.getLatestVersion("invoices_normalized")
  if (!dataset || !raw || !current) throw new Error("[Test] Run the finance pipeline first.")

  const write = await host.lakeStorage.beginWrite({
    dataset: { ...dataset, schema: current.schema },
    mode: "snapshot",
    inputs: [{ datasetId: raw.datasetId, versionId: raw.versionId }],
    producer: { kind: "pipeline", id: "finance", stepId: "normalize-invoices" },
  })

  await write.writeRows(await trustedRows(host, current))
  const { outcome: _outcome, ...version } = await write.commit({ commitMessage: "legacy" })
  return version
}

async function trustedRows(host: SixbHost, version: DatasetVersion) {
  const rows = []

  for await (const row of host.lakeStorage.readRows({
    datasetId: version.datasetId,
    versionId: version.versionId,
  })) {
    rows.push(row)
  }

  return rows
}

// ── Readers ─────────────────────────────────────────────────

async function signIn(reader: Reader, groupId: string): Promise<string> {
  const projectId = "field-ops"
  const userId = `usr_${reader}`
  const credential = createSessionCredential(`ses_${reader}`)

  await storage.auth.users.create({ id: userId, projectId, email: `${reader}@example.com` })
  await storage.auth.groupMemberships.upsert({ projectId, userId, groupId, source: "manual" })
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId,
    strategyId: "dev",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-10-09T10:00:00.000Z"),
    expiresAt: new Date("2099-10-09T10:00:00.000Z"),
  })

  return `sixb_session=${credential.cookieValue}; sixb_csrf=csrf_1`
}

const apis = new WeakMap<SixbHost, ReturnType<typeof createSixbApi>>()

async function request(host: SixbHost, reader: Reader, path: string, init: RequestInit = {}) {
  let api = apis.get(host)
  if (!api) {
    api = createSixbApi(new SixbServer({ host, quiet: true, browser: BROWSER }))
    apis.set(host, api)
  }

  const headers = { cookie: cookies.get(reader) ?? "", "x-sixb-csrf": "csrf_1", ...init.headers }
  const response = await api.fetch(new Request(`http://localhost${path}`, { ...init, headers }))
  return { status: response.status, body: await response.json() }
}

function post(host: SixbHost, reader: Reader, path: string, body: unknown) {
  return request(host, reader, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function readRows(
  host: SixbHost,
  reader: Reader,
  datasetId: string,
  query: { versionId?: string; columns?: string } = {}
) {
  const search = new URLSearchParams(
    Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  const { status, body } = await request(host, reader, `/api/datasets/${datasetId}/rows?${search}`)

  expect({ datasetId, status, body: status === 200 ? null : body }).toMatchObject({
    datasetId,
    status: 200,
  })

  return {
    version: body.version as { schema: { columns: { name: string }[] } },
    columns: body.columns as string[],
    rows: body.rows as Record<string, unknown>[],
    redactions: (body.redactions ?? {}) as Record<string, unknown>,
  }
}

/** The columns a reader cannot read in a version, the latest one by default. */
async function redacted(
  host: SixbHost,
  reader: Reader,
  datasetId: string,
  version?: DatasetVersion
): Promise<string[]> {
  const rows = await readRows(host, reader, datasetId, { versionId: version?.versionId })
  return Object.keys(rows.redactions).sort()
}

async function listObjects(host: SixbHost, reader: Reader, objectTypeId: string) {
  const { status, body } = await request(host, reader, `/api/objects?objectTypeId=${objectTypeId}`)
  expect(status).toBe(200)
  return body.objects as {
    primaryId: string
    properties: Record<string, unknown>
    redactions?: Record<string, unknown>
  }[]
}

/** What each reader should not see: the columns and properties carrying a marking they lack. */
function expectedRedactions() {
  const hiddenFrom = (reader: Reader, markings: Record<string, readonly string[]>) =>
    Object.entries(markings)
      .filter(([, ids]) => ids.some((id) => !READERS[reader].clearances.includes(id)))
      .map(([name]) => name)
      .sort()

  const byReader = (expected: Record<string, Record<string, readonly string[]>>) =>
    Object.fromEntries(
      (Object.keys(READERS) as Reader[]).map((reader) => [
        reader,
        Object.fromEntries(
          Object.entries(expected).map(([id, markings]) => [id, hiddenFrom(reader, markings)])
        ),
      ])
    )

  return { datasets: byReader(COLUMN_MARKINGS), objects: byReader(PROPERTY_MARKINGS) }
}

/**
 * The columns each reader is denied in the latest version of each dataset. Whether asked for by
 * default or by name, a denied column is absent from `columns` and from every row, and every
 * other column is returned.
 */
async function datasetRedactions(host: SixbHost) {
  const result: Record<string, Record<string, string[]>> = {}

  for (const reader of Object.keys(READERS) as Reader[]) {
    result[reader] = {}
    for (const datasetId of Object.keys(COLUMN_MARKINGS)) {
      const all = await readRows(host, reader, datasetId)
      const names = all.version.schema.columns.map((column) => column.name)
      const denied = Object.keys(all.redactions).sort()
      const visible = names.filter((name) => !denied.includes(name))

      expect({ datasetId, reader, columns: all.columns }).toEqual({
        datasetId,
        reader,
        columns: visible,
      })
      for (const row of all.rows) expect(Object.keys(row)).toEqual(visible)

      // Each marked column, and an unmarked one, asked for by name.
      for (const name of [names[0], ...Object.keys(COLUMN_MARKINGS[datasetId])]) {
        const named = await readRows(host, reader, datasetId, { columns: name })
        const expected = visible.includes(name) ? [name] : []

        expect({ datasetId, reader, name, columns: named.columns }).toEqual({
          datasetId,
          reader,
          name,
          columns: expected,
        })
        for (const row of named.rows) expect(Object.keys(row)).toEqual(expected)
      }

      result[reader][datasetId] = denied
    }
  }

  return result
}

/** The properties each reader is denied, the same on every object of a type, read or listed. */
async function objectRedactions(host: SixbHost) {
  const result: Record<string, Record<string, string[]>> = {}

  for (const reader of Object.keys(READERS) as Reader[]) {
    result[reader] = {}
    for (const objectTypeId of Object.keys(PROPERTY_MARKINGS)) {
      const objects = await listObjects(host, reader, objectTypeId)
      expect(objects.length).toBeGreaterThan(0)
      const denied = Object.keys(objects[0].redactions ?? {}).sort()

      for (const object of objects) {
        expect(Object.keys(object.redactions ?? {}).sort()).toEqual(denied)
        expect(Object.keys(object.properties).filter((key) => denied.includes(key))).toEqual([])
      }

      const one = await request(
        host,
        reader,
        `/api/objects/${objectTypeId}/${objects[0].primaryId}`
      )
      expect(Object.keys(one.body.redactions ?? {}).sort()).toEqual(denied)
      result[reader][objectTypeId] = denied
    }
  }

  return result
}

/** What the staff reader is denied in every version the pipelines wrote, read in that order. */
async function historyRedactions(host: SixbHost, order: "oldest first" | "newest first") {
  const result: Record<string, string[]> = {}
  const datasetIds = ["invoices_normalized", "invoice_titles", "invoice_audit", "customer_revenue"]

  for (const datasetId of datasetIds) {
    const newestFirst = await host.lakeStorage.listVersions(datasetId, 50)
    const versions = order === "newest first" ? newestFirst : [...newestFirst].reverse()

    for (const version of versions) {
      const key = `${datasetId}@${version.versionId}`
      result[key] = await redacted(host, "staff", datasetId, version)
    }
  }

  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}
