import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineObjectType, type EmbeddingModel, migrateStorage, prop, SixbHost } from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { PostgresStorage } from "../../../storage/pg/src"
import { quoteIdent } from "../../../storage/pg/src/migrations"
import { createPgClient } from "../../../storage/pg/src/pg-client"
import { SqliteStorage } from "../../../storage/sqlite/src"
import { createClient } from "../../client/src/generated/client"
import { objects as clientObjects } from "../../client/src/query"
import { createTestRuntimeDeps } from "../../core/tests/test-runtime-deps"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// Run explicitly in its own Bun process: SQLite's library choice is process-global.
if (process.platform === "darwin") {
  if (!process.env.SIXB_TEST_SQLITE_LIBRARY) throw new Error("Set SIXB_TEST_SQLITE_LIBRARY")
  Database.setCustomSQLite(process.env.SIXB_TEST_SQLITE_LIBRARY)
}

for (const provider of ["pg", "sqlite"] as const) {
  test(`${provider}: index through SDK, query through real HTTP client, invalidate and reindex`, async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("Run server E2E tests with bun run test:e2e to provision the test database")
    const directory = await mkdtemp(join(tmpdir(), "sixb-vector-http-"))
    const schemaName = `vector_http_${Date.now()}`
    const storage =
      provider === "pg"
        ? new PostgresStorage({ connectionString: process.env.DATABASE_URL, schemaName, max: 2 })
        : new SqliteStorage({ path: directory })
    let server: ReturnType<typeof Bun.serve> | undefined
    try {
      await migrateStorage(storage)
      const model: EmbeddingModel = {
        providerId: "test",
        modelId: "http-v1",
        definition: { kind: "embedding", providerId: "test", modelId: "http-v1", dimensions: 2 },
        async embed({ texts }) {
          return { vectors: texts.map((text) => (text.includes("shoes") ? [1, 0] : [0, 1])) }
        },
      }
      const Product = defineObjectType({
        id: "Product",
        name: "Product",
        properties: [
          prop("id", "string", { primary: true, required: true }),
          prop("title", "string"),
          prop("status", "string", { query: { searchable: true, filterable: true } }),
        ],
        search: { vectors: { content: { source: ["title"], model } } },
      })
      const host = new SixbHost({
        ...createTestRuntimeDeps(),
        id: "http-qualification",
        ontology: [Product],
        models: { embedding: [model] },
        storage,
      })
      await host.closeBroker()
      const objects = createTestSixb(host).objects(Product)
      const app = createSixbApi(
        new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
      )
      server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) })
      const client = createClient({ baseUrl: server.url.toString().replace(/\/$/, "") })
      const remote = clientObjects(Product, { client })
      const query = () =>
        remote
          .query()
          .where((o) => o.p.status.eq("published"))
          .vector("content", "shoes", { k: 2 })
      await objects.upsert({ properties: { id: "one", title: "shoes", status: "published" } })
      expect((await query().list()).objects).toEqual([])
      await objects.byId("one").vector("content").index()
      expect((await query().list()).objects).toMatchObject([{ primaryId: "one", score: 1 }])
      const textQuery = remote.query().vector("content", "comfortable shoes", { k: 2 })
      expect((await textQuery.list()).objects).toMatchObject([{ primaryId: "one", score: 1 }])
      expect(await textQuery.count()).toBe(1)
      expect(await textQuery.exists()).toBe(true)
      expect(await query().count()).toBe(1)
      expect(await query().exists()).toBe(true)
      expect((await query().list({ includeTotal: false })).total).toBeUndefined()
      // Regression proof: removing source invalidation from the Materializer must fail here.
      await objects.upsert({ properties: { id: "one", title: "backpack" } })
      expect((await query().list()).objects).toEqual([])
      await objects.byId("one").vector("content").index()
      expect((await query().list()).objects).toMatchObject([{ primaryId: "one", score: 0 }])
      await objects.upsert({ properties: { id: "one", status: "draft" } })
      expect(await query().count()).toBe(0)
      expect(
        (await remote.query().vector("content", "shoes", { k: 1 }).list()).objects
      ).toHaveLength(1)
      const response = await fetch(new URL("api/objects/query", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            kind: "vector",
            input: { kind: "start", objectTypeId: Product.id },
            profile: "content",
            vector: "shoes",
            k: 1,
            configuration: "forged",
          },
        }),
      })
      expect(response.ok).toBe(false)
    } finally {
      await server?.stop(true)
      await storage.close()
      if (provider === "pg") {
        const sql = createPgClient({
          connectionString: process.env.DATABASE_URL,
          schemaName: "public",
          max: 1,
        })
        try {
          await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`)
        } finally {
          await sql.end()
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
}
