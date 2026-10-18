import { describe, expect, spyOn, test } from "bun:test"
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
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy, getFreePort } from "./helpers"

describe("SixbServer start", () => {
  // Reproduce: return `this.port` from `getPort()` and log it; both report 0 and nothing answers.
  test("reports the port it bound when asked for port 0", async () => {
    const server = new SixbServer({
      host: new SixbHost({
        id: "test-project",
        ontology: [],
        broker: new InMemoryBroker(),
        storage: new InMemoryStorage(),
        lakeStorage: new InMemoryLakeStorage(),
        blobStorage: new InMemoryBlobStorage(),
        queues: new InMemoryQueues(),
      }),
      hostname: "127.0.0.1",
      port: 0,
      browser: createTestBrowserPolicy(),
    })
    const log = spyOn(console, "log").mockImplementation(() => {})
    let logged: unknown[] = []
    try {
      await server.start()
      logged = log.mock.calls.map(([line]) => line)
    } finally {
      log.mockRestore()
    }

    try {
      const port = server.getPort()
      expect(port).toBeGreaterThan(0)
      expect(logged[0]).toBe(`Sixb server running at http://127.0.0.1:${port}`)
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  // Reproduce: remove `checkPipelineMarkings` from `SixbServer.start()`; the server listens.
  test("refuses to start when a SQL step gives a projected column undeclared markings", async () => {
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
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("title", "string"),
      ],
    })
    const normalize = definePipelineStep("normalize-invoices")
      .inputs({ invoices: rawInvoices })
      .output(invoices)
      .sql(({ invoices }) => `SELECT id, CAST(amount AS VARCHAR) AS title FROM ${invoices}`)

    // Analyzes every query as the one above: `title` holds `amount`.
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

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const server = new SixbServer({
      host: new SixbHost({
        id: "test-project",
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
        lakeStorage,
        blobStorage: new InMemoryBlobStorage(),
        queues: new InMemoryQueues(),
      }),
      hostname: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: baseUrl, appOrigin: baseUrl }),
    })

    await expect(server.start()).rejects.toThrow(
      "[Sixb] Projection 'invoices': property 'Invoice.title' is projected from column 'invoices.title', which carries [financial] from 'raw_invoices.amount' through step 'invoices/normalize-invoices'. Add markings: [financial] to the property."
    )
    await expect(fetch(`${baseUrl}/api/project`)).rejects.toThrow()
    await server.stop()
  })
})
