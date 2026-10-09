import { describe, expect, test } from "bun:test"
import {
  AuthorizationError,
  can,
  change,
  col,
  type DatasetRow,
  defineDataset,
  defineGroup,
  defineMarking,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineRole,
  link,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import type { ReadDatasetRowsInput } from "../src/lake-storage"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "dataset-markings"

const financial = defineMarking("financial")
const pii = defineMarking("pii")

const rawInvoices = defineDataset("raw_invoices", {
  schema: [
    col("id", "string"),
    col("title", "string"),
    col("amount", "decimal", { markings: [financial] }),
    col("customer_tax_id", "string", { nullable: true, markings: [financial, pii] }),
  ],
  primaryKey: "id",
})

const analysts = defineGroup("analysts")
const finance = defineGroup("finance")
const datasetReader = defineRole("dataset-reader", {
  grantedTo: [analysts, finance],
  grants: [can.view(rawInvoices)],
})
const financeClearance = defineRole("finance-clearance", {
  grantedTo: [finance],
  clearances: [financial],
})

async function seed() {
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    datasets: [rawInvoices],
    markings: [financial, pii],
    groups: [analysts, finance],
    roles: [datasetReader, financeClearance],
    ...createTestRuntimeDeps(),
  })
  const trusted = createTestSixb(host)
  await trusted.datasets.ingest(rawInvoices, {
    changes: [
      change.upsert({ id: "inv-1", title: "July", amount: "120.00", customer_tax_id: "FR-1" }),
      change.upsert({ id: "inv-2", title: "August", amount: "80.00", customer_tax_id: null }),
    ],
  })
  const readerIn = (groupIds: readonly string[]) =>
    createTestSixb(host, {
      authorization: resolveAuthorizationContext({
        principal: { type: "user", id: `user-${groupIds.join("-")}` },
        groupIds,
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })
  return {
    host,
    trusted,
    analyst: readerIn([analysts.id]),
    financeAnalyst: readerIn([finance.id]),
  }
}

async function collect(rows: AsyncIterable<DatasetRow>): Promise<DatasetRow[]> {
  const collected: DatasetRow[] = []
  for await (const row of rows) collected.push(row)
  return collected
}

describe("column markings", () => {
  test("col records marking ids, and derived datasets keep them", () => {
    expect(rawInvoices.schema.columns[2]).toEqual({
      name: "amount",
      type: "decimal",
      markings: ["financial"],
    })
    expect(col("note", "string", { markings: [] })).toEqual({ name: "note", type: "string" })

    const picked = defineDataset("picked_invoices").derive(rawInvoices, { pick: ["id", "amount"] })
    expect(picked.schema.columns[1]?.markings).toEqual(["financial"])
  })

  test("the lake never stores markings", async () => {
    const { host } = await seed()

    const stored = await host.lakeStorage.getDataset(rawInvoices.id)
    expect(stored?.schema.columns.some((column) => "markings" in column)).toBe(false)
    const version = await host.lakeStorage.getLatestVersion(rawInvoices.id)
    expect(version?.schema.columns.some((column) => "markings" in column)).toBe(false)
  })
})

describe("markings on dataset rows", () => {
  test("a reader without clearance receives marked columns omitted and listed", async () => {
    const { analyst } = await seed()

    const result = await analyst.datasets.readRows(rawInvoices)
    expect(result?.columns).toEqual(["id", "title"])
    // Every redacted column is listed, whether or not it holds a value.
    expect(result?.redactions).toEqual({
      amount: { reason: "missing_clearance" },
      customer_tax_id: { reason: "missing_clearance" },
    })
    expect(await collect(result!.rows)).toEqual([
      { id: "inv-1", title: "July" },
      { id: "inv-2", title: "August" },
    ])
  })

  test("a column needs a clearance for each of its markings", async () => {
    const { financeAnalyst } = await seed()

    const result = await financeAnalyst.datasets.readRows(rawInvoices)
    expect(result?.columns).toEqual(["id", "title", "amount"])
    expect(result?.redactions).toEqual({ customer_tax_id: { reason: "missing_clearance" } })
    expect(await collect(result!.rows)).toEqual([
      { id: "inv-1", title: "July", amount: "120.00" },
      { id: "inv-2", title: "August", amount: "80.00" },
    ])
  })

  test("trusted executions read every column", async () => {
    const { trusted } = await seed()

    const result = await trusted.datasets.readRows(rawInvoices, { limit: 1 })
    expect(result?.redactions).toBeUndefined()
    expect(await collect(result!.rows)).toEqual([
      { id: "inv-1", title: "July", amount: "120.00", customer_tax_id: "FR-1" },
    ])
  })

  test("requesting a marked column omits it instead of failing", async () => {
    const { analyst } = await seed()

    const some = await analyst.datasets.readRows(rawInvoices, { columns: ["amount", "id"] })
    expect(some?.columns).toEqual(["id"])
    expect(await collect(some!.rows)).toEqual([{ id: "inv-1" }, { id: "inv-2" }])

    // Rows keep their count when every requested column is redacted.
    const none = await analyst.datasets.readRows(rawInvoices, { columns: ["amount"], offset: 1 })
    expect(none?.columns).toEqual([])
    expect(await collect(none!.rows)).toEqual([{}])
  })

  test("redacted columns are not requested from the lake", async () => {
    const { host, analyst } = await seed()
    const reads: (readonly string[] | undefined)[] = []
    const readRows = host.lakeStorage.readRows.bind(host.lakeStorage)
    host.lakeStorage.readRows = (input: ReadDatasetRowsInput) => {
      reads.push(input.columns)
      return readRows(input)
    }

    await collect((await analyst.datasets.readRows(rawInvoices))!.rows)
    // Like the lake, an empty column list selects every column, so it cannot bypass redaction.
    await collect((await analyst.datasets.readRows(rawInvoices, { columns: [] }))!.rows)
    expect(reads).toEqual([
      ["id", "title"],
      ["id", "title"],
    ])
  })

  test("reading rows requires the dataset view grant", async () => {
    const { host } = await seed()
    const outsider = createTestSixb(host, {
      authorization: resolveAuthorizationContext({
        principal: { type: "user", id: "outsider" },
        groupIds: [],
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })

    await expect(outsider.datasets.readRows(rawInvoices)).rejects.toBeInstanceOf(AuthorizationError)
  })
})

describe("markings at startup", () => {
  const Customer = defineObjectType({
    id: "Customer",
    name: "Customer",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("score", "double", { mode: "telemetry" }),
    ],
  })
  const Invoice = defineObjectType({
    id: "Invoice",
    name: "Invoice",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("title", "string"),
      prop("amount", "decimal", { markings: [financial] }),
      prop("customerId", "string"),
      prop("updatedAt", "timestamp"),
    ],
    links: [link("customer", Customer, { cardinality: "one" })],
  })
  const invoiceRows = (columns: Parameters<typeof defineDataset>[1]["schema"]) =>
    defineDataset("invoice_rows", { schema: columns })
  const start = (input: Partial<ConstructorParameters<typeof SixbHost>[0]>) => () =>
    new SixbHost({
      id: projectId,
      ontology: [Invoice, Customer],
      markings: [financial, pii],
      ...createTestRuntimeDeps(),
      ...input,
    })

  test("a column may only reference registered markings, once each", () => {
    const unknown = defineDataset("raw", {
      schema: [col("id", "string"), col("x", "string", { markings: [defineMarking("hr")] })],
    })
    expect(start({ datasets: [unknown] })).toThrow(
      "[Sixb] Dataset column 'raw.x' references unknown marking 'hr'. Add it to 'security/markings/' or pass it to createSixb({ markings })."
    )
    const twice = defineDataset("raw", {
      schema: [col("id", "string"), col("x", "string", { markings: [pii, pii] })],
    })
    expect(start({ datasets: [twice] })).toThrow(
      "[Sixb] Dataset column 'raw.x' lists the same marking twice."
    )
  })

  test("a projected property declares the markings of its column", () => {
    const rows = invoiceRows([
      col("id", "string"),
      col("title", "string", { markings: [pii] }),
      col("amount", "decimal", { markings: [financial] }),
    ])
    const projection = defineProjection("invoices", Invoice)
      .fromDataset(rows)
      .properties({ id: "id", title: "title" })
    expect(start({ datasets: [rows], projections: [projection] })).toThrow(
      "[Sixb] Projection 'invoices': property 'Invoice.title' is projected from column 'invoice_rows.title', which carries [pii]. Add markings: [pii] to the property."
    )

    // A property may carry more markings than its column.
    const declared = defineProjection("invoices", Invoice)
      .fromDataset(rows)
      .properties({ id: "id", amount: "amount", customerId: "id" })
    expect(start({ datasets: [rows], projections: [declared] })).not.toThrow()
  })

  test("columns that identify objects or key links cannot be marked", () => {
    const rows = invoiceRows([
      col("id", "string", { markings: [financial] }),
      col("customer_id", "string", { markings: [financial] }),
      col("updated_at", "timestamp", { markings: [financial] }),
      col("plain_id", "string"),
      col("plain_at", "timestamp"),
    ])
    const project = (configure: (base: ReturnType<typeof baseProjection>) => unknown) =>
      start({ datasets: [rows], projections: [configure(baseProjection()) as never] })
    const baseProjection = () => defineProjection("invoices", Invoice).fromDataset(rows)

    expect(project((base) => base.properties({ id: "id" }))).toThrow(
      "[Sixb] Projection 'invoices': column 'invoice_rows.id' becomes the id of 'Invoice' and cannot carry markings."
    )
    expect(
      project((base) =>
        base.properties({ id: "plain_id" }).withLinks({
          customer: { link: Invoice.l.customer, sourceField: "customer_id", target: Customer },
        })
      )
    ).toThrow(
      "[Sixb] Projection 'invoices': column 'invoice_rows.customer_id' keys link 'Invoice.customer' and cannot carry markings."
    )
    expect(
      project((base) =>
        base.properties({ id: "plain_id", amount: "plain_id" }).withLinks({
          customer: {
            link: Invoice.l.customer,
            sourceProperty: Invoice.p.amount,
            target: Customer,
          },
        })
      )
    ).toThrow(
      "[Sixb] Projection 'invoices': property 'Invoice.amount' keys link 'Invoice.customer' and cannot carry markings."
    )
    expect(
      project((base) =>
        base
          .properties({ id: "plain_id", updatedAt: "plain_at" })
          .resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })
      )
    ).toThrow(
      "[Sixb] Projection 'invoices': column 'invoice_rows.updated_at' decides which value wins under 'mostRecent' and cannot carry markings."
    )

    const linkRows = invoiceRows([
      col("invoice_id", "string"),
      col("customer_id", "string", { markings: [financial] }),
    ])
    const linkProjection = defineProjection("invoice-customers", Invoice.l.customer)
      .fromDataset(linkRows)
      .sourceField("invoice_id")
      .targetField("customer_id")
    expect(start({ datasets: [linkRows], projections: [linkProjection] })).toThrow(
      "[Sixb] Projection 'invoice-customers': column 'invoice_rows.customer_id' keys link 'Invoice.customer' and cannot carry markings."
    )
  })

  test("telemetry projections cannot read marked columns", () => {
    const readings = defineDataset("readings", {
      schema: [
        col("customer_id", "string"),
        col("at", "timestamp"),
        col("score", "float64", { markings: [financial] }),
      ],
    })
    const projection = defineProjection("scores", Customer.p.score)
      .fromDataset(readings)
      .points({ objectId: "customer_id", at: "at", value: "score" })
    expect(start({ datasets: [readings], projections: [projection] })).toThrow(
      "[Sixb] Projection 'scores' reads column 'readings.score', which carries [financial]. Telemetry projections cannot read marked columns yet."
    )
  })

  test("pipeline steps cannot read marked columns yet", () => {
    const normalized = defineDataset("normalized_invoices", {
      schema: [col("id", "string"), col("title", "string")],
    })
    const step = definePipelineStep("normalize")
      .inputs({ invoices: rawInvoices })
      .output(normalized)
      .sql(({ invoices }) => `SELECT id, title FROM ${invoices}`)
    expect(
      start({
        datasets: [rawInvoices, normalized],
        pipelines: [definePipeline("invoices").then(step)],
      })
    ).toThrow(
      "[Sixb] Pipeline 'invoices' step 'normalize' reads column 'raw_invoices.amount', which carries [financial]. Pipeline steps cannot read marked columns yet."
    )

    // A step may still mark the columns it produces.
    const scored = defineDataset("scored", {
      schema: [col("id", "string"), col("risk", "float64", { markings: [financial] })],
    })
    const scoring = definePipelineStep("score")
      .inputs({ invoices: normalized })
      .output(scored)
      .run(() => {})
    expect(
      start({ datasets: [normalized, scored], pipelines: [definePipeline("risk").then(scoring)] })
    ).not.toThrow()
  })
})
