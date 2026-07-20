import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, type DatasetDefinition, type DatasetRow, defineDataset } from "@sixb/core"
import type { DatasetVersion } from "@sixb/core/lake-storage"
import type { DuckLakeStorage } from "../src"
import type { DuckDbExclusiveRuntime, DuckDbRuntime } from "../src/internal/duckdb-runtime"
import type { DuckLakeSnapshotReader } from "../src/internal/ducklake-snapshot-reader"
import { encodeDatasetTableName } from "../src/internal/names"
import { qualifiedTableName } from "../src/internal/sql"
import { collectRows, createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    runtime(): Promise<DuckDbRuntime>
  }
  readonly snapshotReader: DuckLakeSnapshotReader
}

describe("DuckLake SQL transforms", () => {
  let rootDir: string
  let storage: DuckLakeStorage

  const customersDataset = defineDataset("raw.crm.customers", {
    schema: [col("customerId", "string"), col("name", "string")],
  })

  const ordersDataset = defineDataset("raw.erp.orders", {
    schema: [col("orderId", "string"), col("customerId", "string"), col("amount", "int64")],
  })

  const customerInsightsDataset = defineDataset("analytics.customer_insights", {
    schema: [col("customerId", "string"), col("orders", "int64"), col("revenue", "int64")],
  })

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-sql-transforms-"))
    storage = createLocalDuckLakeStorage(rootDir)

    await storage.createDataset(customersDataset)
    await storage.createDataset(ordersDataset)
    await storage.createDataset(customerInsightsDataset)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  test("exposes the DuckLake standard and DuckDB SQL capability", () => {
    expect(storage.standard).toEqual({ id: "ducklake", version: "1.0" })
    expect(storage.sql.dialect).toBe("duckdb")
    expect(storage.sql.capabilities).toEqual({
      preview: true,
      supportsAppend: true,
      supportsSnapshot: true,
    })
  })

  test("previews bounded DuckDB SQL over latest source versions", async () => {
    await commitRows(storage, customersDataset, [
      { customerId: "cust_1", name: "Ada" },
      { customerId: "cust_2", name: "Grace" },
    ])
    await commitRows(storage, ordersDataset, [
      { orderId: "ord_1", customerId: "cust_1", amount: 10 },
      { orderId: "ord_2", customerId: "cust_1", amount: 20 },
      { orderId: "ord_3", customerId: "cust_2", amount: 30 },
    ])

    const rows = await collectRows(
      storage.sql.preview({
        sources: {
          customers: { dataset: customersDataset },
          orders: { dataset: ordersDataset },
        },
        limit: 2,
        sql: ({ customers, orders }) => `
          SELECT
            c.customerId,
            c.name,
            o.orderId,
            o.amount
          FROM ${customers} c
          JOIN ${orders} o ON o.customerId = c.customerId
          ORDER BY o.orderId
        `,
      })
    )

    expect(rows).toEqual([
      { customerId: "cust_1", name: "Ada", orderId: "ord_1", amount: "10" },
      { customerId: "cust_1", name: "Ada", orderId: "ord_2", amount: "20" },
    ])
  })

  test("pins provided source versions and resolves omitted versions to latest", async () => {
    const version1 = await commitRows(storage, ordersDataset, [
      { orderId: "ord_1", customerId: "cust_1", amount: 10 },
    ])
    await commitRows(
      storage,
      ordersDataset,
      [{ orderId: "ord_2", customerId: "cust_2", amount: 20 }],
      "append"
    )

    await expect(
      collectRows(
        storage.sql.preview({
          sources: {
            orders: { dataset: ordersDataset, versionId: version1.versionId },
          },
          sql: ({ orders }) => `SELECT orderId FROM ${orders} ORDER BY orderId`,
        })
      )
    ).resolves.toEqual([{ orderId: "ord_1" }])

    await expect(
      collectRows(
        storage.sql.preview({
          sources: {
            orders: { dataset: ordersDataset },
          },
          sql: ({ orders }) => `SELECT orderId FROM ${orders} ORDER BY orderId`,
        })
      )
    ).resolves.toEqual([{ orderId: "ord_1" }, { orderId: "ord_2" }])
  })

  test("applies provider preview caps", async () => {
    await commitRows(
      storage,
      ordersDataset,
      Array.from({ length: 1005 }, (_, index) => ({
        orderId: `ord_${String(index).padStart(4, "0")}`,
        customerId: "cust_1",
        amount: index,
      }))
    )

    const rows = await collectRows(
      storage.sql.preview({
        sources: {
          orders: { dataset: ordersDataset },
        },
        sql: ({ orders }) => `SELECT orderId FROM ${orders} ORDER BY orderId`,
      })
    )

    expect(rows).toHaveLength(100)
    expect(rows[0]).toEqual({ orderId: "ord_0000" })
    expect(rows[99]).toEqual({ orderId: "ord_0099" })

    const cappedRows = await collectRows(
      storage.sql.preview({
        sources: {
          orders: { dataset: ordersDataset },
        },
        limit: 2_000,
        sql: ({ orders }) => `SELECT orderId FROM ${orders} ORDER BY orderId`,
      })
    )

    expect(cappedRows).toHaveLength(1000)
    expect(cappedRows[999]).toEqual({ orderId: "ord_0999" })
  })

  test("rejects unknown or uncommitted source datasets", async () => {
    const missingDataset = defineDataset("raw.missing.orders", {
      schema: [col("orderId", "string")],
    })

    await expect(
      collectRows(
        storage.sql.preview({
          sources: {
            missing: { dataset: missingDataset },
          },
          sql: ({ missing }) => `SELECT * FROM ${missing}`,
        })
      )
    ).rejects.toThrow("Unknown SQL transform source dataset")

    await expect(
      collectRows(
        storage.sql.preview({
          sources: {
            orders: { dataset: ordersDataset },
          },
          sql: ({ orders }) => `SELECT * FROM ${orders}`,
        })
      )
    ).rejects.toThrow("No committed version found")
  })

  test("executes snapshot SQL and commits a normal dataset version", async () => {
    const customersVersion = await commitRows(storage, customersDataset, [
      { customerId: "cust_1", name: "Ada" },
      { customerId: "cust_2", name: "Grace" },
    ])
    const ordersVersion = await commitRows(storage, ordersDataset, [
      { orderId: "ord_1", customerId: "cust_1", amount: 10 },
      { orderId: "ord_2", customerId: "cust_1", amount: 20 },
      { orderId: "ord_3", customerId: "cust_2", amount: 30 },
    ])

    const version = await storage.sql.execute({
      sources: {
        customers: { dataset: customersDataset },
        orders: { dataset: ordersDataset, versionId: ordersVersion.versionId },
      },
      target: customerInsightsDataset,
      mode: "snapshot",
      producer: { kind: "pipeline", id: "customer-insights", runId: "run_1" },
      sql: ({ customers, orders }) => `
        SELECT
          c.customerId,
          count(o.orderId)::BIGINT AS orders,
          sum(o.amount)::BIGINT AS revenue
        FROM ${customers} c
        LEFT JOIN ${orders} o ON o.customerId = c.customerId
        GROUP BY c.customerId
        ORDER BY c.customerId
      `,
    })

    expect(version).toMatchObject({
      datasetId: customerInsightsDataset.id,
      mode: "snapshot",
      schema: customerInsightsDataset.schema,
      producer: { kind: "pipeline", id: "customer-insights", runId: "run_1" },
      inputs: [
        { datasetId: customersDataset.id, versionId: customersVersion.versionId },
        { datasetId: ordersDataset.id, versionId: ordersVersion.versionId },
      ],
      rowCount: 2,
    })
    expect(version.versionId).toStartWith("ducklake:")
    expect(await storage.getLatestVersion(customerInsightsDataset.id)).toMatchObject({
      versionId: version.versionId,
    })

    const rows = await collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
    expect(rows).toEqual([
      { customerId: "cust_1", orders: "2", revenue: "30" },
      { customerId: "cust_2", orders: "1", revenue: "30" },
    ])
  })

  test("pins SQL execute sources before committing the target snapshot", async () => {
    const ordersVersion = await commitRows(storage, ordersDataset, [
      { orderId: "ord_1", customerId: "cust_1", amount: 10 },
    ])
    await commitRows(
      storage,
      ordersDataset,
      [{ orderId: "ord_2", customerId: "cust_1", amount: 20 }],
      "append"
    )

    await storage.sql.execute({
      sources: {
        orders: { dataset: ordersDataset, versionId: ordersVersion.versionId },
      },
      target: customerInsightsDataset,
      mode: "snapshot",
      sql: ({ orders }) => `
        SELECT
          customerId,
          count(orderId)::BIGINT AS orders,
          sum(amount)::BIGINT AS revenue
        FROM ${orders}
        GROUP BY customerId
      `,
    })

    await expect(
      collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
    ).resolves.toEqual([{ customerId: "cust_1", orders: "1", revenue: "10" }])
  })

  test("validates pinned SQL execute sources without full version hydration", async () => {
    const ordersVersion = await commitRows(storage, ordersDataset, [
      { orderId: "ord_1", customerId: "cust_1", amount: 10 },
    ])
    const snapshotReader = (storage as unknown as DuckLakeStorageInternals).snapshotReader
    const getVersionForSnapshot = snapshotReader.getVersionForSnapshot.bind(snapshotReader)
    snapshotReader.getVersionForSnapshot = async (runtime, dataset, snapshotId) => {
      if (dataset.id === ordersDataset.id && ordersVersion.versionId === `ducklake:${snapshotId}`) {
        throw new Error("pinned source should not hydrate full DatasetVersion")
      }

      return getVersionForSnapshot(runtime, dataset, snapshotId)
    }

    try {
      const version = await storage.sql.execute({
        sources: {
          orders: { dataset: ordersDataset, versionId: ordersVersion.versionId },
        },
        target: customerInsightsDataset,
        mode: "snapshot",
        sql: ({ orders }) => `
          SELECT
            customerId,
            count(orderId)::BIGINT AS orders,
            sum(amount)::BIGINT AS revenue
          FROM ${orders}
          GROUP BY customerId
        `,
      })

      expect(version.inputs).toEqual([
        { datasetId: ordersDataset.id, versionId: ordersVersion.versionId },
      ])
      await expect(
        collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
      ).resolves.toEqual([{ customerId: "cust_1", orders: "1", revenue: "10" }])
    } finally {
      snapshotReader.getVersionForSnapshot = getVersionForSnapshot
    }
  })

  test("rejects snapshot SQL execute when the target dataset is unknown", async () => {
    const missingTarget = defineDataset("analytics.missing_target", {
      schema: [col("customerId", "string")],
    })

    await expect(
      storage.sql.execute({
        sources: {},
        target: missingTarget,
        mode: "snapshot",
        sql: () => "SELECT 'cust_1' AS customerId",
      })
    ).rejects.toThrow("Unknown SQL transform target dataset")
  })

  test("rejects snapshot SQL execute when result columns do not match the target schema", async () => {
    await commitRows(storage, ordersDataset, [
      { orderId: "ord_1", customerId: "cust_1", amount: 10 },
    ])

    await expect(
      storage.sql.execute({
        sources: {
          orders: { dataset: ordersDataset },
        },
        target: customerInsightsDataset,
        mode: "snapshot",
        sql: ({ orders }) => `
          SELECT
            customerId,
            customerId AS orders,
            amount AS revenue
          FROM ${orders}
        `,
      })
    ).rejects.toThrow("SQL transform result schema does not match target dataset")
  })

  test("preserves the write error when temp-table cleanup sees an aborted transaction", async () => {
    const previous = await storage.sql.execute({
      sources: {},
      target: customerInsightsDataset,
      mode: "snapshot",
      sql: () => "SELECT 'cust_1' AS customerId, 1::BIGINT AS orders, 10::BIGINT AS revenue",
    })
    const runtime = await (storage as unknown as DuckLakeStorageInternals).connections.runtime()
    const targetTable = qualifiedTableName(
      localDuckLakeOptions(rootDir),
      encodeDatasetTableName(customerInsightsDataset.id)
    )
    const writeError = new Error("Constraint Error: simulated persistent DuckLake insert failure")
    const restoreRuntime = failNextPersistentInsert(runtime, targetTable, writeError)

    try {
      await expect(
        storage.sql.execute({
          sources: {},
          target: customerInsightsDataset,
          mode: "snapshot",
          sql: () => "SELECT 'cust_2' AS customerId, 2::BIGINT AS orders, 20::BIGINT AS revenue",
        })
      ).rejects.toBe(writeError)
    } finally {
      restoreRuntime()
    }

    expect(await storage.getLatestVersion(customerInsightsDataset.id)).toMatchObject({
      versionId: previous.versionId,
    })
    expect(await storage.listVersions(customerInsightsDataset.id)).toHaveLength(1)
    await expect(
      collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
    ).resolves.toEqual([{ customerId: "cust_1", orders: "1", revenue: "10" }])
  })

  test("executes append SQL and keeps lineage on the appended version", async () => {
    const seedVersion = await storage.sql.execute({
      sources: {},
      target: customerInsightsDataset,
      mode: "snapshot",
      sql: () => "SELECT 'cust_1' AS customerId, 1::BIGINT AS orders, 10::BIGINT AS revenue",
    })
    const ordersVersion = await commitRows(storage, ordersDataset, [
      { orderId: "ord_2", customerId: "cust_2", amount: 20 },
      { orderId: "ord_3", customerId: "cust_3", amount: 30 },
    ])

    const appendVersion = await storage.sql.execute({
      sources: {
        orders: { dataset: ordersDataset, versionId: ordersVersion.versionId },
      },
      target: customerInsightsDataset,
      mode: "append",
      expectedLatestVersionId: seedVersion.versionId,
      producer: { kind: "pipeline", id: "customer-insights", runId: "run_2" },
      sql: ({ orders }) => `
        SELECT
          customerId,
          count(orderId)::BIGINT AS orders,
          sum(amount)::BIGINT AS revenue
        FROM ${orders}
        GROUP BY customerId
        ORDER BY customerId
      `,
    })

    expect(appendVersion).toMatchObject({
      datasetId: customerInsightsDataset.id,
      parentVersionId: seedVersion.versionId,
      mode: "append",
      producer: { kind: "pipeline", id: "customer-insights", runId: "run_2" },
      inputs: [{ datasetId: ordersDataset.id, versionId: ordersVersion.versionId }],
      rowCount: 3,
    })
    await expect(
      collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
    ).resolves.toEqual([
      { customerId: "cust_1", orders: "1", revenue: "10" },
      { customerId: "cust_2", orders: "1", revenue: "20" },
      { customerId: "cust_3", orders: "1", revenue: "30" },
    ])
  })

  test("rejects stale expected latest versions for SQL execute commits", async () => {
    const firstVersion = await storage.sql.execute({
      sources: {},
      target: customerInsightsDataset,
      mode: "snapshot",
      sql: () => "SELECT 'cust_1' AS customerId, 1::BIGINT AS orders, 10::BIGINT AS revenue",
    })
    await storage.sql.execute({
      sources: {},
      target: customerInsightsDataset,
      mode: "append",
      sql: () => "SELECT 'cust_2' AS customerId, 1::BIGINT AS orders, 20::BIGINT AS revenue",
    })

    await expect(
      storage.sql.execute({
        sources: {},
        target: customerInsightsDataset,
        mode: "append",
        expectedLatestVersionId: firstVersion.versionId,
        sql: () => "SELECT 'cust_3' AS customerId, 1::BIGINT AS orders, 30::BIGINT AS revenue",
      })
    ).rejects.toThrow("Optimistic commit failed")
  })

  test("rejects invalid SQL execute modes before writing", async () => {
    await expect(
      storage.sql.execute({
        sources: {},
        target: customerInsightsDataset,
        mode: "merge" as never,
        sql: () => "SELECT 'cust_1' AS customerId, 1::BIGINT AS orders, 10::BIGINT AS revenue",
      })
    ).rejects.toThrow("Invalid SQL transform mode")

    await expect(
      collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
    ).rejects.toThrow("No committed version found")
  })

  test("keeps explicit empty-result commit semantics for SQL execute", async () => {
    await expect(
      storage.sql.execute({
        sources: {},
        target: customerInsightsDataset,
        mode: "snapshot",
        sql: () => `
          SELECT
            'cust_none' AS customerId,
            0::BIGINT AS orders,
            0::BIGINT AS revenue
          WHERE false
        `,
      })
    ).rejects.toThrow("No DuckLake changes were committed")

    const seedVersion = await storage.sql.execute({
      sources: {},
      target: customerInsightsDataset,
      mode: "snapshot",
      sql: () => "SELECT 'cust_1' AS customerId, 1::BIGINT AS orders, 10::BIGINT AS revenue",
    })

    const emptyAppendVersion = await storage.sql.execute({
      sources: {},
      target: customerInsightsDataset,
      mode: "append",
      sql: () => `
        SELECT
          'cust_none' AS customerId,
          0::BIGINT AS orders,
          0::BIGINT AS revenue
        WHERE false
      `,
    })

    expect(emptyAppendVersion.outcome).toBe("unchanged")
    expect(emptyAppendVersion.versionId).toBe(seedVersion.versionId)
    await expect(
      collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
    ).resolves.toEqual([{ customerId: "cust_1", orders: "1", revenue: "10" }])

    const emptySnapshotVersion = await storage.sql.execute({
      sources: {},
      target: customerInsightsDataset,
      mode: "snapshot",
      sql: () => `
        SELECT
          'cust_none' AS customerId,
          0::BIGINT AS orders,
          0::BIGINT AS revenue
        WHERE false
      `,
    })

    expect(emptySnapshotVersion.outcome).toBe("created")
    expect(emptySnapshotVersion.versionId).not.toBe(seedVersion.versionId)
    expect(emptySnapshotVersion.rowCount).toBe(0)
    await expect(
      collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
    ).resolves.toEqual([])
  })

  test("throws a clear no-op error for empty first SQL append", async () => {
    await expect(
      storage.sql.execute({
        sources: {},
        target: customerInsightsDataset,
        mode: "append",
        sql: () => `
          SELECT
            'cust_none' AS customerId,
            0::BIGINT AS orders,
            0::BIGINT AS revenue
          WHERE false
        `,
      })
    ).rejects.toThrow("No DuckLake changes were committed")
  })
})

async function commitRows(
  storage: DuckLakeStorage,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[],
  mode: "snapshot" | "append" = "snapshot"
): Promise<DatasetVersion> {
  const write = await storage.beginWrite({ dataset, mode })
  await write.writeRows(rows)
  return write.commit()
}

function failNextPersistentInsert(
  runtime: DuckDbRuntime,
  targetTable: string,
  writeError: Error
): () => void {
  const originalWithExclusive = runtime.withExclusive.bind(runtime)
  let transactionAborted = false
  let insertFailed = false

  runtime.withExclusive = (useRuntime) =>
    originalWithExclusive((exclusiveRuntime) =>
      useRuntime(
        wrapExclusiveRuntime(exclusiveRuntime, async (sql, values) => {
          if (!insertFailed && sql.startsWith(`INSERT INTO ${targetTable} `)) {
            insertFailed = true
            transactionAborted = true
            throw writeError
          }

          if (transactionAborted && sql.startsWith('DROP TABLE IF EXISTS "sixb_sql_transform_')) {
            throw new Error(
              "TransactionContext Error: Current transaction is aborted (please ROLLBACK)"
            )
          }

          if (sql === "ROLLBACK") {
            transactionAborted = false
          }

          await exclusiveRuntime.run(sql, values)
        })
      )
    )

  return () => {
    runtime.withExclusive = originalWithExclusive
  }
}

function wrapExclusiveRuntime(
  runtime: DuckDbExclusiveRuntime,
  run: DuckDbExclusiveRuntime["run"]
): DuckDbExclusiveRuntime {
  return {
    run,
    runStatements: (statements) => runtime.runStatements(statements),
    query: (sql, values) => runtime.query(sql, values),
    withAppender: (tableName, useAppender) => runtime.withAppender(tableName, useAppender),
  }
}
