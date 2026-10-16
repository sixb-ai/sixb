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
const normalize = definePipelineStep("normalize-invoices")
  .inputs({ invoices: rawInvoices })
  .output(normalizedInvoices)
  .sql(normalizeQuery)

type HostOptions = Partial<ConstructorParameters<typeof SixbHost>[0]>

function startHost(options: HostOptions = {}): SixbHost {
  return new SixbHost({
    id: "pipeline-markings",
    ontology: [Invoice],
    markings: [financial, pii],
    datasets: [rawInvoices, normalizedInvoices],
    pipelines: [definePipeline("invoices").then(normalize)],
    projections: [invoiceProjection],
    ...createTestRuntimeDeps(),
    ...options,
  })
}

/** `"invoices.amount"` → a column of the step input named `invoices`. */
function analysis(lineage: {
  readonly rows?: readonly string[]
  readonly columns: Readonly<Record<string, readonly string[]>>
}): SqlTransformAnalysis {
  const ref = (path: string) => {
    const [source = "", column = ""] = path.split(".")
    return { source, column }
  }
  return {
    supported: true,
    lineage: {
      rows: (lineage.rows ?? []).map(ref),
      columns: Object.fromEntries(
        Object.entries(lineage.columns).map(([column, refs]) => [column, refs.map(ref)])
      ),
    },
  }
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

const exactNormalize = analysis({
  columns: {
    id: ["invoices.id"],
    title: ["invoices.title"],
    amount: ["invoices.amount"],
  },
})

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

  test("every output column of a run step inherits every column it reads", () => {
    expect(() =>
      startHost({
        pipelines: [definePipeline("invoices").then(runStep({ invoices: rawInvoices }))],
      })
    ).toThrow(
      "[Sixb] Projection 'invoices': column 'normalized_invoices.id' becomes the id of 'Invoice' and cannot carry markings, but carries [financial] from 'raw_invoices.amount' through step 'invoices/score-invoices' and [pii] from 'raw_invoices.customer_tax_id' through step 'invoices/score-invoices'."
    )

    // A step that reads only unmarked columns derives no marking.
    const picked = runStep({ invoices: rawInvoices.pick("id", "title") })
    expect(() => startHost({ pipelines: [definePipeline("invoices").then(picked)] })).not.toThrow()
  })

  test("markings go around a cycle of steps", () => {
    const drafts = defineDataset("invoice_drafts", { schema: [col("id", "string")] })
    // Runs first, but only marks its output once the step after it has.
    const review = definePipelineStep("review-invoices")
      .inputs({ invoices: rawInvoices.pick("id", "amount"), reviewed: normalizedInvoices })
      .output(drafts)
      .run(() => {})
    const publish = definePipelineStep("publish-invoices")
      .inputs({ drafts })
      .output(normalizedInvoices)
      .run(() => {})

    expect(() =>
      startHost({
        datasets: [rawInvoices, normalizedInvoices, drafts],
        pipelines: [definePipeline("invoices").then(review).then(publish)],
      })
    ).toThrow(
      "[Sixb] Projection 'invoices': column 'normalized_invoices.id' becomes the id of 'Invoice' and cannot carry markings, but carries [financial] from 'raw_invoices.amount' through steps 'invoices/review-invoices', 'invoices/publish-invoices'."
    )
  })

  test("SQL steps derive nothing until the preflight analyzes them", () => {
    expect(() => startHost()).not.toThrow()
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
  test("derives each output column's markings from the analyzed SQL", async () => {
    const { lakeStorage, calls } = analyzingLake(new Map([[normalizeQuery, exactNormalize]]))
    const host = startHost({ lakeStorage })

    await checkPipelineMarkings({ definitions: host.definitions, lakeStorage })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sources.invoices).toEqual({
      dataset: rawInvoices,
      columns: ["id", "title", "amount", "customer_tax_id"],
    })
  })

  test("names the path a marking took to a property that does not declare it", async () => {
    // The step copies the amount into the title.
    const copiesAmount = analysis({
      columns: { id: ["invoices.id"], title: ["invoices.amount"], amount: ["invoices.amount"] },
    })
    const { lakeStorage } = analyzingLake(new Map([[normalizeQuery, copiesAmount]]))
    const host = startHost({ lakeStorage })

    await expect(
      checkPipelineMarkings({ definitions: host.definitions, lakeStorage })
    ).rejects.toThrow(
      "[Sixb] Projection 'invoices': property 'Invoice.title' is projected from column 'normalized_invoices.title', which carries [financial] from 'raw_invoices.amount' through step 'invoices/normalize-invoices'. Add markings: [financial] to the property."
    )
  })

  test("row selection marks every output column", async () => {
    // SELECT id, title, amount FROM invoices WHERE amount > 100
    const filtersOnAmount = analysis({
      rows: ["invoices.amount"],
      columns: { id: ["invoices.id"], title: ["invoices.title"], amount: ["invoices.amount"] },
    })
    const { lakeStorage } = analyzingLake(new Map([[normalizeQuery, filtersOnAmount]]))
    const host = startHost({ lakeStorage })

    await expect(
      checkPipelineMarkings({ definitions: host.definitions, lakeStorage })
    ).rejects.toThrow(
      "[Sixb] Projection 'invoices': column 'normalized_invoices.id' becomes the id of 'Invoice' and cannot carry markings, but carries [financial] from 'raw_invoices.amount' through step 'invoices/normalize-invoices'."
    )
  })

  test("a column the lineage does not list depends on every column the step reads", async () => {
    const partial = analysis({ columns: { id: ["invoices.id"], amount: ["invoices.amount"] } })
    const { lakeStorage } = analyzingLake(new Map([[normalizeQuery, partial]]))
    const host = startHost({ lakeStorage })

    await expect(
      checkPipelineMarkings({ definitions: host.definitions, lakeStorage })
    ).rejects.toThrow(
      "property 'Invoice.title' is projected from column 'normalized_invoices.title', which carries [financial] from 'raw_invoices.amount' through step 'invoices/normalize-invoices' and [pii] from 'raw_invoices.customer_tax_id' through step 'invoices/normalize-invoices'."
    )
  })

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

  test("SQL the provider cannot analyze is reported with its step and reason", async () => {
    const pivot: SqlTransformAnalysis = { supported: false, reason: "PIVOT is not supported" }
    const { lakeStorage } = analyzingLake(new Map([[normalizeQuery, pivot]]))
    const host = startHost({ lakeStorage })

    await expect(
      checkPipelineMarkings({ definitions: host.definitions, lakeStorage })
    ).rejects.toThrow(
      "[Sixb] Pipeline 'invoices' step 'normalize-invoices' reads column 'raw_invoices.amount', which carries [financial], but its SQL cannot be analyzed: PIVOT is not supported. Rewrite that part of the query, or pick only unmarked columns."
    )
  })

  test("a provider failure names the step it was analyzing", async () => {
    // The stub throws for any query it was not given.
    const { lakeStorage } = analyzingLake(new Map())
    const host = startHost({ lakeStorage })

    await expect(
      checkPipelineMarkings({ definitions: host.definitions, lakeStorage })
    ).rejects.toThrow(
      "[Sixb] Pipeline 'invoices' step 'normalize-invoices' could not be analyzed: unexpected query"
    )
  })

  test("analyzes a few steps at a time", async () => {
    // Twenty steps reading a marked column, all in the first wave.
    const steps = Array.from({ length: 20 }, (_, index) => {
      const output = defineDataset(`normalized_${index}`, {
        schema: [col("id", "string"), col("title", "string"), col("amount", "decimal")],
      })
      const step = definePipelineStep(`normalize-${index}`)
        .inputs({ invoices: rawInvoices })
        .output(output)
        .sql(normalizeQuery)
      return { output, step }
    })
    const { lakeStorage, calls, mostAtOnce } = analyzingLake(
      new Map([[normalizeQuery, exactNormalize]])
    )
    const host = startHost({
      lakeStorage,
      datasets: [rawInvoices, normalizedInvoices, ...steps.map(({ output }) => output)],
      pipelines: [
        steps.reduce((pipeline, { step }) => pipeline.then(step), definePipeline("many")),
      ],
    })

    await checkPipelineMarkings({ definitions: host.definitions, lakeStorage })
    // Reproduce: analyze a whole wave with an unbounded Promise.all.
    expect(calls).toHaveLength(20)
    expect(mostAtOnce()).toBe(8)
  })

  test("a step reused by two pipelines is analyzed once", async () => {
    const { lakeStorage, calls } = analyzingLake(new Map([[normalizeQuery, exactNormalize]]))
    const host = startHost({
      lakeStorage,
      pipelines: [
        definePipeline("invoices").then(normalize),
        definePipeline("backfill").then(normalize),
      ],
    })

    await checkPipelineMarkings({ definitions: host.definitions, lakeStorage })
    expect(calls).toHaveLength(1)
  })

  // Reproduce: drop the loop over the step's inputs in MarkingPropagation.apply; the count reads
  // no column of `rich`, so it carries nothing and the projection passes.
  test("a count over a filtered input carries what decided its rows", async () => {
    const richInvoices = defineDataset("rich_invoices", { schema: [col("id", "string")] })
    const richStats = defineDataset("rich_stats", {
      schema: [col("label", "string"), col("invoice_count", "int64")],
    })
    const RichStats = defineObjectType({
      id: "RichStats",
      name: "RichStats",
      properties: [
        prop("label", "string", { required: true, primary: true }),
        prop("invoiceCount", "integer"),
      ],
    })
    const filterQuery: SqlTransformBody = ({ invoices }) =>
      `SELECT id FROM ${invoices} WHERE amount > 100`
    const filter = definePipelineStep("filter-rich")
      .inputs({ invoices: rawInvoices })
      .output(richInvoices)
      .sql(filterQuery)
    const countQuery: SqlTransformBody = ({ rich }) =>
      `SELECT 'all' AS label, count(*) AS invoice_count FROM ${rich}`
    const count = definePipelineStep("count-rich")
      .inputs({ rich: richInvoices })
      .output(richStats)
      .sql(countQuery)
    const { lakeStorage } = analyzingLake(
      new Map([
        [filterQuery, analysis({ rows: ["invoices.amount"], columns: { id: ["invoices.id"] } })],
        // Neither column names a column of `rich`.
        [countQuery, analysis({ columns: { label: [], invoice_count: [] } })],
      ])
    )
    const host = startHost({
      lakeStorage,
      ontology: [RichStats],
      datasets: [rawInvoices, richInvoices, richStats],
      pipelines: [definePipeline("invoices").then(filter).then(count)],
      projections: [
        defineProjection("rich-stats", RichStats)
          .fromDataset(richStats)
          .properties({ label: "label", invoiceCount: "invoice_count" }),
      ],
    })

    await expect(
      checkPipelineMarkings({ definitions: host.definitions, lakeStorage })
    ).rejects.toThrow(
      // Even the constant label: zero rows would say that no invoice exceeds 100.
      "[Sixb] Projection 'rich-stats': column 'rich_stats.label' becomes the id of 'RichStats' and cannot carry markings, but carries [financial] from 'raw_invoices.amount' through steps 'invoices/filter-rich', 'invoices/count-rich'."
    )
  })

  test("a lake provider that cannot analyze SQL cannot run SQL over marked columns", async () => {
    const host = startHost()

    await expect(
      checkPipelineMarkings({ definitions: host.definitions, lakeStorage: host.lakeStorage })
    ).rejects.toThrow(
      "[Sixb] Pipeline 'invoices' step 'normalize-invoices' reads column 'raw_invoices.amount', which carries [financial], but the lake provider cannot analyze SQL to derive the markings of its output. Use a lake provider that analyzes SQL, or pick only unmarked columns."
    )
  })

  test("markings flow through chained, self-reading, and concurrent producers", async () => {
    const enrichedInvoices = defineDataset("enriched_invoices", {
      schema: [col("id", "string"), col("title", "string"), col("note", "string")],
    })
    const Enriched = defineObjectType({
      id: "Enriched",
      name: "Enriched",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("title", "string"),
        prop("note", "string"),
      ],
    })
    const enrichedProjection = defineProjection("enriched", Enriched)
      .fromDataset(enrichedInvoices)
      .properties({ id: "id", title: "title", note: "note" })

    // Reads normalized_invoices, which only carries markings once 'normalize-invoices' is analyzed,
    // and its own previous output.
    const enrichQuery: SqlTransformBody = ({ invoices, previous }) =>
      `SELECT i.id, i.title, p.note FROM ${invoices} i LEFT JOIN ${previous} p USING (id)`
    const enrich = definePipelineStep("enrich-invoices")
      .inputs({ invoices: normalizedInvoices, previous: enrichedInvoices })
      .output(enrichedInvoices, { mode: "append" })
      .sql(enrichQuery)
    // A second producer of the same dataset copies the amount into the note.
    const annotateQuery: SqlTransformBody = ({ invoices }) =>
      `SELECT id, title, CAST(amount AS VARCHAR) AS note FROM ${invoices}`
    const annotate = definePipelineStep("annotate-invoices")
      .inputs({ invoices: normalizedInvoices })
      .output(enrichedInvoices, { mode: "append" })
      .sql(annotateQuery)

    const { lakeStorage, calls } = analyzingLake(
      new Map([
        [normalizeQuery, exactNormalize],
        [
          enrichQuery,
          analysis({
            rows: ["invoices.id", "previous.id"],
            columns: { id: ["invoices.id"], title: ["invoices.title"], note: ["previous.note"] },
          }),
        ],
        [
          annotateQuery,
          analysis({
            columns: { id: ["invoices.id"], title: ["invoices.title"], note: ["invoices.amount"] },
          }),
        ],
      ])
    )
    const host = startHost({
      lakeStorage,
      ontology: [Invoice, Enriched],
      datasets: [rawInvoices, normalizedInvoices, enrichedInvoices],
      pipelines: [definePipeline("invoices").then(enrich).then(normalize).then(annotate)],
      projections: [invoiceProjection, enrichedProjection],
    })

    await expect(
      checkPipelineMarkings({ definitions: host.definitions, lakeStorage })
    ).rejects.toThrow(
      "[Sixb] Projection 'enriched': property 'Enriched.note' is projected from column 'enriched_invoices.note', which carries [financial] from 'raw_invoices.amount' through steps 'invoices/normalize-invoices', 'invoices/annotate-invoices'. Add markings: [financial] to the property."
    )
    expect(calls).toHaveLength(3)
  })
})
