import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
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
  type SixbHostOptions,
} from "@sixb/core"
import type { DomainEventService } from "@sixb/core/internal/events"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

function createSixbInstance(options: SixbHostOptions): SixbHost {
  return new SixbHost(options)
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer() as ReturnType<typeof createServer> & {
      on(event: string, listener: (error: Error) => void): void
    }
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(port)
      })
    })
  })
}

async function waitForWsMessages(
  url: string,
  count: number,
  outgoingMessage?: string
): Promise<Record<string, unknown>[]> {
  return await new Promise<Record<string, unknown>[]>((resolvePromise, reject) => {
    const ws = new WebSocket(url)
    const messages: Record<string, unknown>[] = []
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error("Timed out waiting for websocket messages"))
    }, 3000)

    ws.addEventListener("message", (event) => {
      const raw =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : String(event.data)

      try {
        const message = JSON.parse(raw) as Record<string, unknown>
        messages.push(message)

        if (messages.length === 1 && outgoingMessage) {
          setTimeout(() => {
            ws.send(outgoingMessage)
          }, 0)
        }

        if (messages.length >= count) {
          clearTimeout(timeout)
          ws.close()
          resolvePromise(messages)
        }
      } catch (error) {
        clearTimeout(timeout)
        ws.close()
        reject(error)
      }
    })

    ws.addEventListener("error", () => {
      clearTimeout(timeout)
      ws.close()
      reject(new Error("WebSocket error"))
    })
  })
}

describe("SixbServer API serving", () => {
  async function withUnifiedServer(
    run: (context: { baseUrl: string }) => Promise<void>
  ): Promise<void> {
    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`

    const sixb = createSixbInstance({
      id: "test-project",
      ontology: [],
      broker: new InMemoryBroker(),
      storage: new InMemoryStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })

    await (sixb.events as DomainEventService).publishEnvelopes([
      {
        id: "telemetry-fan-1-rpm",
        schemaVersion: 1,
        projectId: sixb.id,
        correlationId: "correlation-fan-1-rpm",
        origin: { kind: "runtime", requestId: "seed-fan-1-rpm" },
        executor: { type: "request", requestId: "seed-fan-1-rpm" },
        commitId: "commit-fan-1-rpm",
        commitOrdinal: 0,
        type: "telemetry.appended",
        topic: "telemetry",
        partitionKey: "device:fan-1:rpm",
        occurredAt: "2026-02-18T10:00:10.000Z",
        payload: {
          objectTypeId: "device",
          objectId: "fan-1",
          propertyId: "rpm",
          value: 1200,
          at: "2026-02-18T10:00:10.000Z",
        },
      },
    ])

    const server = new SixbServer({
      host: sixb,
      hostname: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: baseUrl, appOrigin: baseUrl }),
    })

    await server.start()

    try {
      await run({ baseUrl })
    } finally {
      await server.stop()
    }
  }

  test("routes API paths to Elysia", async () => {
    await withUnifiedServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/project`)
      expect(response.status).toBe(200)

      const body = (await response.json()) as { id: string }
      expect(body.id).toBe("test-project")
    })
  })

  test("opens websocket connections on /ws/events", async () => {
    await withUnifiedServer(async ({ baseUrl }) => {
      const wsUrl = baseUrl.replace("http://", "ws://")
      const [message] = await waitForWsMessages(`${wsUrl}/ws/events`, 1)

      expect(message).toEqual({
        type: "connected",
        channel: "events",
      })
    })
  })

  test("returns websocket errors for invalid messages", async () => {
    await withUnifiedServer(async ({ baseUrl }) => {
      const wsUrl = baseUrl.replace("http://", "ws://")
      const messages = await waitForWsMessages(`${wsUrl}/ws/events`, 2, "not-json")

      expect(messages[0]).toEqual({
        type: "connected",
        channel: "events",
      })
      expect(messages[1]).toEqual({
        type: "error",
        message: "Message must be a JSON object.",
      })
    })
  })
})

describe("SixbServer start", () => {
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
      host: createSixbInstance({
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
      browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
    })

    await expect(server.start()).rejects.toThrow(
      "[Sixb] Projection 'invoices': property 'Invoice.title' is projected from column 'invoices.title', which carries [financial] from 'raw_invoices.amount' through step 'invoices/normalize-invoices'. Add markings: [financial] to the property."
    )
    await expect(fetch(`${baseUrl}/api/project`)).rejects.toThrow()
    await server.stop()
  })
})
