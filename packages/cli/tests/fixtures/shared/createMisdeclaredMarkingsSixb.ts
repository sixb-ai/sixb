import {
  col,
  defineDataset,
  defineMarking,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LakeStorageWithSql,
  prop,
  SixbHost,
} from "@sixb/core"

const financial = defineMarking("financial")

const rawInvoices = defineDataset("raw_invoices", {
  schema: [col("id", "string"), col("amount", "decimal", { markings: [financial] })],
})
const invoices = defineDataset("invoices", {
  schema: [col("id", "string"), col("title", "string")],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true }), prop("title", "string")],
})

const normalize = definePipelineStep("normalize-invoices")
  .inputs({ invoices: rawInvoices })
  .output(invoices)
  .sql(({ invoices }) => `SELECT id, CAST(amount AS VARCHAR) AS title FROM ${invoices}`)

/** A lake that analyzes every query as the step above: `title` holds `amount`. */
function createAnalyzingLake(): LakeStorageWithSql {
  return Object.assign(new InMemoryLakeStorage(), {
    sql: {
      dialect: "duckdb" as const,
      capabilities: { preview: false, supportsAppend: true, supportsSnapshot: true },
      preview: () => {
        throw new Error("preview is not used")
      },
      execute: () => {
        throw new Error("execute is not used")
      },
      analyze: async () => ({
        supported: true as const,
        lineage: {
          rows: [],
          columns: {
            id: [{ source: "invoices", column: "id" }],
            title: [{ source: "invoices", column: "amount" }],
          },
        },
      }),
    },
  })
}

/**
 * A project startup accepts, because it cannot see through SQL, but whose SQL step copies a
 * marked column into a property that does not declare the marking.
 */
export function createMisdeclaredMarkingsSixb(projectId: string) {
  return new SixbHost({
    id: projectId,
    ontology: [Invoice],
    markings: [financial],
    datasets: [rawInvoices, invoices],
    pipelines: [definePipeline("invoices").then(normalize)],
    projections: [
      defineProjection("invoices", Invoice)
        .fromDataset(invoices)
        .properties({ id: "id", title: "title" }),
    ],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: createAnalyzingLake(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}

export const MISDECLARED_MARKINGS_MESSAGE =
  "[Sixb] Projection 'invoices': property 'Invoice.title' is projected from column 'invoices.title', which carries [financial] from 'raw_invoices.amount' through step 'invoices/normalize-invoices'. Add markings: [financial] to the property."
