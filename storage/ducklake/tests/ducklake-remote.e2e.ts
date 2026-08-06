import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset } from "@sixb/core"
import { SQL } from "bun"
import { type DuckDbSecretOptions, DuckLakeStorage, type DuckLakeStorageOptions } from "../src"
import { collectRows } from "./test-utils"

describe("DuckLakeStorage remote catalogs", () => {
  test("uses a PostgreSQL catalog with a local data path", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-local-"))
    const dataset = defineDataset(`raw.pg.local.${randomId()}`, {
      schema: [col("orderId", "string")],
      primaryKey: "orderId",
    })
    const storage = new DuckLakeStorage({
      catalog: postgresCatalog(),
      dataPath: join(rootDir, "data"),
    })

    try {
      await storage.createDataset(dataset)
      await expect(storage.getDataset(dataset.id)).resolves.toEqual(dataset)
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows([{ orderId: "ord_1" }])
      await write.commit()

      const append = await storage.beginWrite({ dataset, mode: "append" })
      await append.writeRows([{ orderId: "ord_2" }])
      await append.commit()

      expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toEqual([
        { orderId: "ord_1" },
        { orderId: "ord_2" },
      ])
    } finally {
      await storage.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test("uses a PostgreSQL catalog with an S3-compatible data path", async () => {
    const dataset = defineDataset(`raw.pg.s3.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const storage = new DuckLakeStorage({
      catalog: postgresCatalog(),
      dataPath: `s3://${s3Bucket()}/lake/${randomId()}`,
      secrets: [minioSecret()],
    })

    try {
      await storage.createDataset(dataset)
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows([{ orderId: "ord_1" }])
      await write.commit()

      expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toEqual([
        { orderId: "ord_1" },
      ])
    } finally {
      await storage.close()
    }
  })

  test("does not exhaust the PostgreSQL catalog pool across repeated metadata reads", async () => {
    const dataset = defineDataset(`raw.pg.metadata.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const storage = new DuckLakeStorage({
      catalog: postgresCatalog(),
      dataPath: `s3://${s3Bucket()}/lake/${randomId()}`,
      secrets: [minioSecret()],
    })

    try {
      await storage.createDataset(dataset)
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows([{ orderId: "ord_1" }])
      const version = await write.commit()

      for (let index = 0; index < 20; index += 1) {
        await expect(storage.getDataset(dataset.id)).resolves.toMatchObject({ id: dataset.id })
        await expect(storage.getLatestVersion(dataset.id)).resolves.toMatchObject({
          versionId: version.versionId,
        })
      }
    } finally {
      await storage.close()
    }
  }, 60_000)

  test("allows two provider instances to commit to one PostgreSQL catalog", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-shared-"))
    const dataset = defineDataset(`raw.pg.shared.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const options: DuckLakeStorageOptions = {
      catalog: postgresCatalog(),
      dataPath: join(rootDir, "data"),
    }
    const first = new DuckLakeStorage(options)
    const second = new DuckLakeStorage(options)

    try {
      await first.createDataset(dataset)

      const firstWrite = await first.beginWrite({ dataset, mode: "snapshot" })
      await firstWrite.writeRows([{ orderId: "ord_1" }])
      const firstVersion = await firstWrite.commit()

      const secondWrite = await second.beginWrite({ dataset, mode: "append" })
      await secondWrite.writeRows([{ orderId: "ord_2" }])
      await secondWrite.commit({ expectedLatestVersionId: firstVersion.versionId })

      expect(await collectRows(first.readRows({ datasetId: dataset.id }))).toEqual([
        { orderId: "ord_1" },
        { orderId: "ord_2" },
      ])
    } finally {
      await first.close()
      await second.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test("operates within a constrained PostgreSQL catalog connection budget", async () => {
    const catalogConnectionBudget = 4
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-budget-"))
    const roleName = `sixb_limited_${randomId()}`
    const password = `pw_${randomId()}`
    const metadataSchema = `sixb_${randomId()}`
    const applicationName = `sixb_budget_${randomId()}`
    const adminSql = createAdminSql()
    const dataset = defineDataset(`raw.pg.budget.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const projectionDataset = defineDataset(`analytics.pg.budget.${randomId()}`, {
      schema: [col("orderId", "string")],
    })
    const catalog = postgresCatalog()
    if (catalog.type !== "postgres") {
      throw new Error("[SixbDuckLake] Expected PostgreSQL catalog test configuration.")
    }

    const storage = new DuckLakeStorage({
      catalog: {
        ...catalog,
        user: roleName,
        password,
        metadataSchema,
        applicationName,
      },
      dataPath: join(rootDir, "data"),
      duckdb: {
        config: {
          threads: "1",
        },
      },
      postgresPool: {
        maxConnections: catalogConnectionBudget,
        idleTimeoutMillis: 100,
        enableThreadLocalCache: false,
      },
    })
    let closeError: unknown

    try {
      await adminSql.unsafe(
        `CREATE ROLE ${quotePgIdent(roleName)} WITH LOGIN PASSWORD ${quotePgLiteral(
          password
        )} NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT ${catalogConnectionBudget}`
      )
      await adminSql.unsafe(
        `CREATE SCHEMA ${quotePgIdent(metadataSchema)} AUTHORIZATION ${quotePgIdent(roleName)}`
      )

      await expectCatalogConnectionsAtMost(adminSql, roleName, 0, "before first lake operation")
      await runBudgetStep("create dataset", () => storage.createDataset(dataset))
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after source dataset create"
      )
      await runBudgetStep("create projection dataset", () =>
        storage.createDataset(projectionDataset)
      )
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after projection dataset create"
      )

      const write = await runBudgetStep("begin snapshot write", () =>
        storage.beginWrite({ dataset, mode: "snapshot" })
      )
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after begin snapshot write"
      )
      await runBudgetStep("stage snapshot rows", () => write.writeRows([{ orderId: "ord_1" }]))
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after stage snapshot rows"
      )
      await runBudgetStep("commit snapshot write", () => write.commit())
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after commit snapshot write"
      )

      const append = await runBudgetStep("begin append write", () =>
        storage.beginWrite({ dataset, mode: "append" })
      )
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after begin append write"
      )
      await runBudgetStep("stage append rows", () => append.writeRows([{ orderId: "ord_2" }]))
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after stage append rows"
      )
      await runBudgetStep("commit append write", () => append.commit())
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after commit append write"
      )

      for (let index = 0; index < 10; index += 1) {
        await expect(
          runBudgetStep(`get dataset ${index}`, () => storage.getDataset(dataset.id))
        ).resolves.toMatchObject({ id: dataset.id })
        await expect(
          runBudgetStep(`get latest version ${index}`, () => storage.getLatestVersion(dataset.id))
        ).resolves.toMatchObject({
          datasetId: dataset.id,
        })
        await expectCatalogConnectionsAtMost(
          adminSql,
          roleName,
          catalogConnectionBudget,
          `after repeated metadata read ${index}`
        )
      }

      expect(
        await runBudgetStep("read rows", () =>
          collectRows(storage.readRows({ datasetId: dataset.id }))
        )
      ).toEqual([{ orderId: "ord_1" }, { orderId: "ord_2" }])
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after read rows"
      )

      await runBudgetStep("execute SQL transform", () =>
        storage.sql.execute({
          sources: {
            orders: { dataset },
          },
          target: projectionDataset,
          mode: "snapshot",
          sql: ({ orders }) => `SELECT orderId FROM ${orders} ORDER BY orderId`,
        })
      )
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after SQL transform commit"
      )
      expect(
        await runBudgetStep("read projected rows", () =>
          collectRows(storage.readRows({ datasetId: projectionDataset.id }))
        )
      ).toEqual([{ orderId: "ord_1" }, { orderId: "ord_2" }])
      await expectCatalogConnectionsAtMost(
        adminSql,
        roleName,
        catalogConnectionBudget,
        "after read projected rows"
      )
    } finally {
      try {
        await storage.close()
        // The DuckDB PostgreSQL extension can retain one pool's worth of idle
        // backends after runtime close; the provider must not leave more than
        // the configured pool budget behind.
        await expectCatalogConnectionsAtMost(
          adminSql,
          roleName,
          catalogConnectionBudget,
          "after storage close"
        )
      } catch (error) {
        closeError = error
      }

      await terminateCatalogConnections(adminSql, roleName)
      await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${quotePgIdent(metadataSchema)} CASCADE`)
      await adminSql.unsafe(`DROP ROLE IF EXISTS ${quotePgIdent(roleName)}`)
      await adminSql.close()
      await rm(rootDir, { recursive: true, force: true })
    }

    if (closeError !== undefined) {
      throw closeError
    }
  }, 60_000)
})

function postgresCatalog(): DuckLakeStorageOptions["catalog"] {
  return {
    type: "postgres",
    host: process.env.SIXB_DUCKLAKE_POSTGRES_HOST ?? "127.0.0.1",
    port: Number(process.env.SIXB_DUCKLAKE_POSTGRES_PORT ?? "54331"),
    database: process.env.SIXB_DUCKLAKE_POSTGRES_DATABASE ?? "postgres",
    user: process.env.SIXB_DUCKLAKE_POSTGRES_USER ?? "postgres",
    password: process.env.SIXB_DUCKLAKE_POSTGRES_PASSWORD ?? "test",
    metadataSchema: `sixb_${randomId()}`,
  }
}

function minioSecret(): DuckDbSecretOptions {
  return {
    type: "s3",
    keyId: process.env.SIXB_DUCKLAKE_S3_KEY_ID ?? "sixb",
    secret: process.env.SIXB_DUCKLAKE_S3_SECRET ?? "sixb-secret",
    region: "us-east-1",
    endpoint: process.env.SIXB_DUCKLAKE_S3_ENDPOINT ?? "127.0.0.1:19000",
    urlStyle: "path",
    useSsl: false,
    scope: `s3://${s3Bucket()}`,
  }
}

function s3Bucket(): string {
  return process.env.SIXB_DUCKLAKE_S3_BUCKET ?? "sixb-ducklake"
}

function randomId(): string {
  return randomUUID().replaceAll("-", "_")
}

function createAdminSql(): SQL {
  const url = new URL(
    `postgres://${process.env.SIXB_DUCKLAKE_POSTGRES_HOST ?? "127.0.0.1"}:${
      process.env.SIXB_DUCKLAKE_POSTGRES_PORT ?? "54331"
    }/${process.env.SIXB_DUCKLAKE_POSTGRES_DATABASE ?? "postgres"}`
  )
  url.username = process.env.SIXB_DUCKLAKE_POSTGRES_USER ?? "postgres"
  url.password = process.env.SIXB_DUCKLAKE_POSTGRES_PASSWORD ?? "test"

  return new SQL({ url: url.toString(), max: 1 })
}

async function expectCatalogConnectionsAtMost(
  sql: SQL,
  roleName: string,
  maxConnections: number,
  step: string
): Promise<void> {
  const deadline = Date.now() + 5_000
  let connections: CatalogConnectionRow[] = []

  while (Date.now() < deadline) {
    connections = await catalogConnections(sql, roleName)
    if (connections.length <= maxConnections) {
      expect(connections.length).toBeLessThanOrEqual(maxConnections)
      return
    }

    await sleep(50)
  }

  throw new Error(
    `[SixbDuckLake] Expected at most ${maxConnections} PostgreSQL catalog connection(s) for role '${roleName}' ${step}, found ${connections.length}: ${JSON.stringify(
      connections
    )}`
  )
}

interface CatalogConnectionRow {
  readonly application_name: string
  readonly state: string | null
  readonly wait_event_type: string | null
  readonly wait_event: string | null
  readonly query: string
}

async function catalogConnections(sql: SQL, roleName: string): Promise<CatalogConnectionRow[]> {
  return (await sql.unsafe(
    `
      SELECT application_name, state, wait_event_type, wait_event, query
      FROM pg_stat_activity
      WHERE usename = $1
      ORDER BY application_name, state, wait_event_type, wait_event, query
    `,
    [roleName]
  )) as CatalogConnectionRow[]
}

async function terminateCatalogConnections(sql: SQL, roleName: string): Promise<void> {
  await sql.unsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1", [
    roleName,
  ])
}

async function runBudgetStep<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[SixbDuckLake] Constrained connection budget test failed during ${step}: ${message}`
    )
  }
}

function quotePgIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function quotePgLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}
