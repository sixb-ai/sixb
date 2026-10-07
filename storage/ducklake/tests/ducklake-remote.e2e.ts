import { describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { change, col, type DatasetDefinition, defineDataset } from "@sixb/core"
import { SQL } from "bun"
import { type DuckDbSecretOptions, DuckLakeStorage, type DuckLakeStorageOptions } from "../src"
import type { DuckDbRuntime } from "../src/internal/duckdb-runtime"
import { encodeDatasetTableName } from "../src/internal/names"
import { collectRows } from "./test-utils"

describe("DuckLakeStorage remote catalogs", () => {
  for (const [budget, readers] of [
    [4, 4],
    [8, 4],
    [32, 16],
  ] as const) {
    test(`keeps writes available with four threads and ${readers} readers (pool ${budget})`, async () => {
      const options: DuckLakeStorageOptions = {
        catalog: { ...postgresCatalog(), applicationName: `sixb_reader_${randomId()}` },
        duckdb: { config: { threads: "4", memory_limit: "512MB" } },
        maxStreamingReads: readers,
        postgresPool: { maxConnections: budget, waitTimeoutMillis: 1_000 },
      }
      // Red check: reduce the connection reserve from four to three. The pool=4 fixture retains
      // a metadata transaction; an immediate append can time out depending on driver cleanup.
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures/reader-postgres-budget.ts"),
          JSON.stringify(options),
          String(readers),
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 15_000 }
      )
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, output, error }).toEqual({ code: 0, output: "", error: "" })
    }, 20_000)
  }

  // Regression proof: remove the DuckLake snapshot-CAS error classification; one child fails COMMIT.
  for (const scenario of ["different keys", "same key", "existing key", "deletion"] as const)
    test(`rebases source changes across processes: ${scenario}`, async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "sixb-source-processes-"))
      const dataset = defineDataset(`source.processes.${randomId()}`, {
        schema: [col("id", "string"), col("revision", "int64")],
        primaryKey: "id",
        sequenceBy: "revision",
      })
      const options: DuckLakeStorageOptions = {
        catalog: postgresCatalog(),
        dataPath: join(rootDir, "data"),
      }
      const storage = new DuckLakeStorage(options)
      await storage.createDataset(dataset)
      if (scenario === "existing key" || scenario === "deletion") {
        const seed = await storage.beginMerge({ dataset })
        await seed.writeChanges([change.upsert({ id: "42", revision: 7 })])
        await seed.commit()
      }
      const children = [
        [change.upsert({ id: "42", revision: 8 })],
        scenario === "deletion"
          ? [change.delete({ id: "42" }, { sequence: 9 })]
          : [change.upsert({ id: scenario === "different keys" ? "other" : "42", revision: 9 })],
      ].map((changes) => {
        let resolveReady!: () => void
        let rejectReady!: (error: Error) => void
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve
          rejectReady = reject
        })
        const process = Bun.spawn(
          [
            Bun.argv[0],
            join(import.meta.dir, "fixtures/concurrent-source-merge.ts"),
            JSON.stringify(options),
            JSON.stringify(dataset),
            JSON.stringify(changes),
          ],
          {
            stdout: "ignore",
            stderr: "pipe",
            timeout: 30_000,
            ipc(message) {
              if (
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "ready"
              )
                resolveReady()
            },
          }
        )
        const stderrText = new Response(process.stderr).text()
        const finished = process.exited.then(async (code) => {
          const stderr = await stderrText
          // Rejecting an already-resolved readiness promise has no effect.
          rejectReady(new Error(stderr || `child exited ${code} before reaching COMMIT`))
          return { code, stderr }
        })
        return { process, ready, finished }
      })
      try {
        // Both transactions reach COMMIT from the same base in independent Bun processes.
        await Promise.all(children.map((child) => child.ready))
        for (const child of children) child.process.send("commit")
        for (const child of children) {
          const { code, stderr } = await child.finished
          if (code !== 0) throw new Error(stderr)
        }
        const rows = await collectRows(storage.readRows({ datasetId: dataset.id }))
        if (scenario === "different keys")
          expect(rows.map((row) => row.id).sort()).toEqual(["42", "other"])
        else expect(rows).toEqual(scenario === "deletion" ? [] : [{ id: "42", revision: "9" }])
      } finally {
        for (const child of children) child.process.kill()
        await Promise.all(children.map((child) => child.finished))
        await storage.close()
        await rm(rootDir, { recursive: true, force: true })
      }
    }, 40_000)
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
      const appendVersion = await append.commit()

      const merge = await storage.beginMerge({ dataset })
      await merge.writeChanges([
        change.delete({ orderId: "ord_1" }),
        change.upsert({ orderId: "ord_3" }),
      ])
      const mergeResult = await merge.commit()

      expect(mergeResult).toMatchObject({
        outcome: "created",
        version: {
          mode: "merge",
          parentVersionId: appendVersion.versionId,
          rowCount: 2,
        },
      })

      expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toEqual([
        { orderId: "ord_2" },
        { orderId: "ord_3" },
      ])
    } finally {
      await storage.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test("reads versions and changes over a long PostgreSQL catalog history", async () => {
    // Red check: restore the catalog-wide snapshot walk in querySnapshotCandidates. The stale read
    // then pages through 30k snapshots, about 235 queries, each copying catalog text out of
    // PostgreSQL. Production catalogs reach this length because snapshots are never expired.
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-history-"))
    const catalog = postgresCatalog()
    const storage = new DuckLakeStorage({ catalog, dataPath: join(rootDir, "data") })
    const datasetFor = (name: string) =>
      defineDataset(`raw.pg.history.${name}_${randomId()}`, { schema: [col("id", "string")] })
    const busy = datasetFor("busy")
    const stale = datasetFor("stale")
    const empty = datasetFor("empty")
    const commit = async (dataset: DatasetDefinition, ids: readonly string[]) => {
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows(ids.map((id) => ({ id })))
      return write.commit()
    }
    const adminSql = createAdminSql()

    try {
      for (const dataset of [busy, stale, empty]) await storage.createDataset(dataset)
      const original = await commit(stale, ["original"])
      await commit(busy, ["first"])
      await appendPostgresHistory(adminSql, catalog.metadataSchema ?? "main", busy.id, 30_000)
      const busyLatest = await commit(busy, ["after history"])
      // A first empty write is a metadata-only snapshot, found through its Sixb commit metadata.
      const emptyVersion = await commit(empty, [])
      const cursor = (await storage.listLatestVersionsSince({ cursor: null }))?.cursor ?? null

      const runtime = await (
        storage as unknown as { connections: { attachedRuntime(): Promise<DuckDbRuntime> } }
      ).connections.attachedRuntime()
      const query = spyOn(runtime, "query")
      const counted = async <T>(read: () => Promise<T>) => {
        query.mockClear()
        const result = await read()
        return { result, queries: query.mock.calls.length }
      }
      try {
        const latest = await counted(() => storage.getLatestVersion(stale.id))
        expect(latest.result?.versionId).toBe(original.versionId)
        expect(latest.queries).toBeLessThanOrEqual(4)
        await expect(storage.getLatestVersion(busy.id)).resolves.toMatchObject({
          versionId: busyLatest.versionId,
        })
        await expect(storage.getLatestVersion(empty.id)).resolves.toMatchObject({
          versionId: emptyVersion.versionId,
          mode: "snapshot",
        })

        const append = await storage.beginWrite({ dataset: stale, mode: "append" })
        await append.writeRows([{ id: "appended" }])
        const appended = await append.commit()
        await expect(storage.getVersion(stale.id, appended.versionId)).resolves.toMatchObject({
          parentVersionId: original.versionId,
        })

        const changed = await counted(() => storage.listLatestVersionsSince({ cursor }))
        expect(changed.result?.versions).toMatchObject([
          { datasetId: stale.id, versionId: appended.versionId, mode: "append" },
        ])
        const idle = await counted(() =>
          storage.listLatestVersionsSince({ cursor: changed.result?.cursor ?? null })
        )
        expect(idle.result?.versions).toEqual([])
        expect(idle.queries).toBe(1)
      } finally {
        query.mockRestore()
      }
    } finally {
      await storage.close()
      await adminSql.unsafe(
        `DROP SCHEMA IF EXISTS ${quotePgIdent(catalog.metadataSchema ?? "main")} CASCADE`
      )
      await adminSql.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  }, 60_000)

  test("reads versions from a PostgreSQL catalog without a metadata schema", async () => {
    // Red check: name the default metadata schema `main`; the first version lookup then fails
    // because DuckLake wrote its tables to PostgreSQL's `public` schema.
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-pg-default-schema-"))
    const database = `sixb_${randomId()}`
    const adminSql = createAdminSql()
    await adminSql.unsafe(`CREATE DATABASE ${quotePgIdent(database)}`)
    const { metadataSchema: _metadataSchema, ...catalog } = postgresCatalog()
    const storage = new DuckLakeStorage({
      catalog: { ...catalog, database },
      dataPath: join(rootDir, "data"),
    })
    const dataset = defineDataset("raw.pg.default_schema", { schema: [col("id", "string")] })

    try {
      await storage.createDataset(dataset)
      const head = await storage.listLatestVersionsSince({ cursor: null })
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows([{ id: "a" }])
      const version = await write.commit()

      await expect(storage.getLatestVersion(dataset.id)).resolves.toMatchObject({
        versionId: version.versionId,
      })
      await expect(
        storage.listLatestVersionsSince({ cursor: head?.cursor ?? null })
      ).resolves.toMatchObject({ versions: [{ versionId: version.versionId }] })
    } finally {
      await storage.close()
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${quotePgIdent(database)} WITH (FORCE)`)
      await adminSql.close()
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
      secrets: [s3Secret()],
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
      secrets: [s3Secret()],
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

      const bulk = await storage.beginWrite({ dataset: projectionDataset, mode: "snapshot" })
      await bulk.writeRows(Array.from({ length: 20_003 }, (_, i) => ({ orderId: `bulk_${i}` })))
      await bulk.commit()
      const controller = new AbortController()
      // More inputs than both the default streaming cap and the role's connection limit.
      const readers = Array.from({ length: 6 }, () =>
        storage
          .readRows({ datasetId: projectionDataset.id, signal: controller.signal })
          [Symbol.asyncIterator]()
      )
      try {
        // Red check: admit every native reader regardless of the PostgreSQL pool budget.
        // Paused streams then exhaust the four-connection role and opening further readers times out.
        await runBudgetStep("open concurrent readers", () =>
          Promise.all(readers.map((r) => r.next()))
        )
        const concurrentWrite = await storage.beginWrite({ dataset, mode: "append" })
        await concurrentWrite.writeRows([{ orderId: "ord_3" }])
        await runBudgetStep("commit while readers are paused", () => concurrentWrite.commit())
        await expectCatalogConnectionsAtMost(
          adminSql,
          roleName,
          catalogConnectionBudget,
          "during concurrent reads and writes"
        )
      } finally {
        controller.abort()
        await Promise.all(readers.map((reader) => reader.return?.()))
      }
      expect(await collectRows(storage.readRows({ datasetId: dataset.id }))).toHaveLength(3)
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

function postgresCatalog(): Extract<DuckLakeStorageOptions["catalog"], { type: "postgres" }> {
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

function s3Secret(): DuckDbSecretOptions {
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

/** Appends Sixb commits to one dataset, as inline DuckLake inserts, after the latest snapshot. */
async function appendPostgresHistory(
  sql: SQL,
  metadataSchema: string,
  datasetId: string,
  length: number
): Promise<void> {
  const table = (name: string) => `${quotePgIdent(metadataSchema)}.${quotePgIdent(name)}`
  const [busyTable] = await sql.unsafe(
    `SELECT table_id FROM ${table("ducklake_table")}
     WHERE table_name = ${quotePgLiteral(encodeDatasetTableName(datasetId))} AND end_snapshot IS NULL`
  )
  await sql.unsafe(`
    INSERT INTO ${table("ducklake_snapshot")}
      (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id)
    SELECT
      latest.snapshot_id + offsets.n,
      latest.snapshot_time + offsets.n * interval '1 second',
      latest.schema_version,
      latest.next_catalog_id,
      latest.next_file_id
    FROM (SELECT * FROM ${table("ducklake_snapshot")} ORDER BY snapshot_id DESC LIMIT 1) latest,
      generate_series(1, ${length}) AS offsets(n)
  `)
  await sql.unsafe(`
    INSERT INTO ${table("ducklake_snapshot_changes")}
      (snapshot_id, changes_made, author, commit_message, commit_extra_info)
    SELECT
      snapshot.snapshot_id,
      ${quotePgLiteral(`inlined_insert:${busyTable?.table_id}`)},
      'Sixb',
      'history',
      ${quotePgLiteral(`{"sixb":{"kind":"datasetVersion","datasetId":${JSON.stringify(datasetId)},"mode":"append","commitId":"history-`)}
        || snapshot.snapshot_id || '"}}'
    FROM ${table("ducklake_snapshot")} snapshot
    LEFT JOIN ${table("ducklake_snapshot_changes")} changes USING (snapshot_id)
    WHERE changes.snapshot_id IS NULL
  `)
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
