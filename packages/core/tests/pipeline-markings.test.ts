import { describe, expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  defineConnector,
  defineDataset,
  defineMarking,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineSync,
  type PipelineStepDefinition,
  prop,
  SixbHost,
} from "../src"
import {
  type AnalyzeSqlTransformInput,
  type DatasetColumnLineage,
  InMemoryLakeStorage,
  type LakeStorageWithSql,
  type SqlTransformAnalysis,
  type SqlTransformBody,
} from "../src/lake-storage"
import { runStepLineage, stepInputColumns } from "../src/pipelines"
import { checkPipelineMarkings } from "../src/security/internal"
import { MarkingPropagation } from "../src/security/marking-propagation"
import { createTestRuntimeDeps } from "./test-runtime-deps"

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
const normalizedInvoices = defineDataset("normalized_invoices", {
  schema: [col("id", "string"), col("title", "string"), col("amount", "decimal")],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("title", "string"),
    prop("amount", "decimal", { markings: [financial] }),
  ],
})
const invoiceProjection = defineProjection("invoices", Invoice)
  .fromDataset(normalizedInvoices)
  .properties({ id: "id", title: "title", amount: "amount" })

const normalizeQuery: SqlTransformBody = ({ invoices }) =>
  `SELECT id, title, amount * 1.2 AS amount FROM ${invoices}`

type HostOptions = Partial<ConstructorParameters<typeof SixbHost>[0]>

function startHost(options: HostOptions = {}): SixbHost {
  return new SixbHost({
    id: "pipeline-markings",
    ontology: [Invoice],
    markings: [financial, pii],
    datasets: [rawInvoices, normalizedInvoices],
    projections: [invoiceProjection],
    ...createTestRuntimeDeps(),
    ...options,
  })
}

/** A lake whose SQL provider analyzes each query with the lineage the test gives it. */
function analyzingLake(analyses: ReadonlyMap<SqlTransformBody, SqlTransformAnalysis>) {
  const calls: AnalyzeSqlTransformInput[] = []
  const concurrency = { running: 0, most: 0 }
  const lakeStorage: LakeStorageWithSql = Object.assign(new InMemoryLakeStorage(), {
    sql: {
      dialect: "duckdb" as const,
      capabilities: { preview: false, supportsAppend: true, supportsSnapshot: true },
      preview: () => {
        throw new Error("preview is not used")
      },
      execute: () => {
        throw new Error("execute is not used")
      },
      analyze: async (input: AnalyzeSqlTransformInput) => {
        calls.push(input)
        concurrency.running += 1
        concurrency.most = Math.max(concurrency.most, concurrency.running)
        // Analyses take time, so concurrent ones overlap.
        await Bun.sleep(1)
        concurrency.running -= 1
        const result = analyses.get(input.sql)
        if (!result) throw new Error("unexpected query")
        return result
      },
    },
  })
  return { lakeStorage, calls, mostAtOnce: () => concurrency.most }
}

describe("pick", () => {
  test("returns the same dataset with only the picked columns, in order", () => {
    const picked = rawInvoices.pick("title", "id")

    expect<DatasetDefinition>(picked).toEqual({
      kind: "dataset",
      id: "raw_invoices",
      schema: { columns: [rawInvoices.schema.columns[1], rawInvoices.schema.columns[0]] },
    })
    expect(stepInputColumns(picked)).toEqual(["title", "id"])
    expect(stepInputColumns(rawInvoices)).toEqual(["id", "title", "amount", "customer_tax_id"])
  })

  test("keeps the definition plain data", () => {
    expect(Object.keys(rawInvoices)).toEqual(["kind", "id", "schema", "primaryKey"])
    expect("pick" in structuredClone(rawInvoices)).toBe(false)
    expect("pick" in { ...rawInvoices }).toBe(false)
    expect(defineDataset("copy").derive(rawInvoices).pick("amount").schema.columns).toEqual([
      rawInvoices.schema.columns[2],
    ])
  })

  test("rejects empty, repeated, and unknown columns", () => {
    const pick = rawInvoices.pick as (...columns: string[]) => unknown
    expect(() => pick()).toThrow("[Sixb] Dataset 'raw_invoices' pick needs at least one column.")
    expect(() => pick("id", "id")).toThrow(
      "[Sixb] Dataset 'raw_invoices' pick lists column 'id' twice."
    )
    expect(() => pick("total")).toThrow(
      "[Sixb] Dataset 'raw_invoices' has no column 'total' to pick."
    )
  })
})

describe("pipeline steps at startup", () => {
  const runStep = (inputs: Record<string, DatasetDefinition>) =>
    definePipelineStep("score-invoices")
      .inputs(inputs)
      .output(normalizedInvoices)
      .run(() => {})

  test("only a pick reads some columns: a stale copy of a definition is rejected", () => {
    const subject = "Pipeline 'invoices' step 'score-invoices' input 'invoices'"
    const start = (input: DatasetDefinition) => () =>
      startHost({ pipelines: [definePipeline("invoices").then(runStep({ invoices: input }))] })

    // Reproduce: treat every input whose columns exist on the dataset as a pick in startup.
    const stale = defineDataset("raw_invoices", {
      schema: [col("id", "string"), col("title", "string")],
    })
    expect(start(stale)).toThrow(
      `${subject} lacks columns of dataset 'raw_invoices'. Use the registered definition, or .pick(...) to read some of its columns.`
    )
    expect(start(rawInvoices.pick("id", "title"))).not.toThrow()

    const unknown = defineDataset("raw_invoices", {
      schema: [col("id", "string"), col("total", "decimal")],
    })
    expect(start(unknown)).toThrow(
      `${subject} has column 'total', which dataset 'raw_invoices' does not declare. Use the registered definition.`
    )
    const retyped = defineDataset("raw_invoices", { schema: [col("amount", "float64")] })
    expect(start(retyped)).toThrow(
      `${subject} has column 'amount' as 'float64', but dataset 'raw_invoices' declares it as 'decimal'. Use the registered definition.`
    )
  })

  test("a sync target is the whole dataset", () => {
    const erp = defineConnector("erp", { type: "sql", connect: () => ({}) })
    const sync = defineSync("sync-invoices")
      .from(erp)
      .read(() => [])
      .intoDataset(rawInvoices.pick("id", "title"))
    expect(() => startHost({ connectors: [erp], syncs: [sync] })).toThrow(
      "Sync 'sync-invoices' target 'raw_invoices' must be the whole dataset, not a pick."
    )
  })

  test("a step output is the whole dataset", () => {
    const step = definePipelineStep("normalize-invoices")
      .inputs({ invoices: rawInvoices.pick("id", "title") })
      .output(normalizedInvoices.pick("id", "title"))
      .sql(normalizeQuery)
    expect(() => startHost({ pipelines: [definePipeline("invoices").then(step)] })).toThrow(
      "Pipeline 'invoices' step 'normalize-invoices' output 'normalized_invoices' must be the whole dataset, not a pick."
    )
  })

  // Reproduce: do not report a change when only the output's row markings grow in
  // MarkingPropagation.apply; the count is not revisited and stays unmarked.
  test("a step whose rows gain a marking its columns already carry revisits its readers", () => {
    const rich = defineDataset("rich", { schema: [col("id", "string")] })
    const amounts = defineDataset("amounts", { schema: [col("amount", "decimal")] })
    const counts = defineDataset("counts", { schema: [col("n", "int64")] })
    const ref = (datasetId: string, column: string) => ({ datasetId, column })
    const sql = (
      id: string,
      inputs: Record<string, DatasetDefinition>,
      output: DatasetDefinition
    ) =>
      definePipelineStep(id)
        .inputs(inputs)
        .output(output)
        .sql(() => "")
    // rich: SELECT id FROM raw_invoices WHERE amount > 100
    const filter = sql("filter", { invoices: rawInvoices }, rich)
    // amounts: SELECT amount FROM raw_invoices, rich: carries `financial` by its value, then by
    // the rows of `rich` once `filter` is known.
    const copy = sql("copy", { invoices: rawInvoices, rich }, amounts)
    // counts: SELECT count(*) AS n FROM amounts
    const count = sql("count", { amounts }, counts)
    const steps = [filter, copy, count].map((step) => ({ pipelineId: "p", step }))
    const lineages = new Map<PipelineStepDefinition, DatasetColumnLineage>([
      [
        filter,
        { rows: [ref(rawInvoices.id, "amount")], columns: { id: [ref(rawInvoices.id, "id")] } },
      ],
      [copy, { rows: [], columns: { amount: [ref(rawInvoices.id, "amount")] } }],
      [count, { rows: [], columns: { n: [] } }],
    ])
    const markings = new MarkingPropagation(
      new Map([rawInvoices, rich, amounts, counts].map((dataset) => [dataset.id, dataset])),
      steps
    )

    // The later step is analyzed first, as the preflight's waves may.
    markings.derive(({ step }) => (step === filter ? null : (lineages.get(step) ?? null)))
    expect(markings.of(ref(counts.id, "n")).size).toBe(0)
    markings.derive(({ step }) => lineages.get(step) ?? null)
    expect(markings.of(ref(counts.id, "n")).get("financial")).toEqual({
      column: ref(rawInvoices.id, "amount"),
      steps: ["p/filter", "p/copy", "p/count"],
    })
  })
})

describe("run step lineage", () => {
  test("every output column depends on every column the step reads, once each", () => {
    const step = definePipelineStep("score-invoices")
      .inputs({ titles: rawInvoices.pick("id", "title"), ids: rawInvoices.pick("id") })
      .output(normalizedInvoices)
      .run(() => {})
    const datasetsById = new Map([rawInvoices, normalizedInvoices].map((d) => [d.id, d]))

    expect(runStepLineage(step as PipelineStepDefinition, datasetsById)).toEqual({
      rows: [
        { datasetId: "raw_invoices", column: "id" },
        { datasetId: "raw_invoices", column: "title" },
      ],
      columns: { id: [], title: [], amount: [] },
    })
  })
})

describe("pipeline markings preflight", () => {
  test("a step that reads no marked column is not analyzed", async () => {
    const step = definePipelineStep("normalize-invoices")
      .inputs({ invoices: rawInvoices.pick("id", "title") })
      .output(normalizedInvoices)
      .sql(normalizeQuery)
    const { lakeStorage, calls } = analyzingLake(new Map())
    const host = startHost({ lakeStorage, pipelines: [definePipeline("invoices").then(step)] })

    await checkPipelineMarkings({ definitions: host.definitions, lakeStorage })
    expect(calls).toEqual([])
  })
})
