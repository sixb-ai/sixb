import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  col,
  type DatasetDefinition,
  type DatasetRow,
  type DatasetSchema,
  defineDataset,
} from "@sixb/core"
import {
  type DatasetColumnLineage,
  type DatasetProducer,
  type DatasetVersion,
  LakeStorageError,
  type SqlTransformBody,
} from "@sixb/core/lake-storage"
import type { DuckLakeStorage } from "../src"
import type { DuckDbExclusiveRuntime, DuckDbRuntime } from "../src/internal/duckdb-runtime"
import type { DuckLakeDatasetCatalog } from "../src/internal/ducklake-dataset-catalog"
import type { DuckLakeSnapshotReader } from "../src/internal/ducklake-snapshot-reader"
import { encodeDatasetTableName } from "../src/internal/names"
import { qualifiedTableName } from "../src/internal/sql"
import { collectRows, createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    runtime(): Promise<DuckDbRuntime>
  }
  readonly snapshotReader: DuckLakeSnapshotReader
  readonly datasets: DuckLakeDatasetCatalog
}

describe.each(["duckdb", "sqlite"] as const)("DuckLake %s SQL transforms", (catalog) => {
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
    storage = createLocalDuckLakeStorage(rootDir, catalog)

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

  test("previews decimal expressions without converting through a JavaScript number", async () => {
    await commitRows(storage, ordersDataset, [
      { orderId: "ord_1", customerId: "cust_1", amount: 1 },
    ])

    await expect(
      collectRows(
        storage.sql.preview({
          sources: { orders: { dataset: ordersDataset } },
          sql: ({ orders }) => `
            SELECT 9007199254740993.123456789::DECIMAL(38, 9) AS amount
            FROM ${orders}
          `,
        })
      )
    ).resolves.toEqual([{ amount: "9007199254740993.123456789" }])
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

  test("normalizes promoted BIGINT sums to the target int64 type", async () => {
    const totalsDataset = defineDataset("analytics.order_totals", {
      schema: [col("customerId", "string"), col("total", "int64")],
    })
    await storage.createDataset(totalsDataset)
    await commitRows(storage, ordersDataset, [
      { orderId: "ord_1", customerId: "cust_1", amount: 10 },
      { orderId: "ord_2", customerId: "cust_2", amount: 20 },
    ])

    const first = await storage.sql.execute({
      sources: { orders: { dataset: ordersDataset } },
      target: totalsDataset,
      mode: "snapshot",
      sql: ({ orders }) => `
        SELECT customerId, sum(amount) AS total
        FROM ${orders}
        GROUP BY customerId
        ORDER BY customerId DESC
      `,
    })

    expect(first.outcome).toBe("created")
    expect(first.rowCount).toBe(2)
    await expect(collectRows(storage.readRows({ datasetId: totalsDataset.id }))).resolves.toEqual([
      { customerId: "cust_2", total: "20" },
      { customerId: "cust_1", total: "10" },
    ])

    const repeated = await storage.sql.execute({
      sources: { orders: { dataset: ordersDataset } },
      target: totalsDataset,
      mode: "snapshot",
      sql: ({ orders }) => `
        SELECT customerId, sum(amount) AS total
        FROM ${orders}
        GROUP BY customerId
        ORDER BY customerId DESC
      `,
    })

    expect(repeated.outcome).toBe("unchanged")
    expect(repeated.versionId).toBe(first.versionId)

    await commitRows(storage, ordersDataset, [
      { orderId: "ord_max_1", customerId: "cust_1", amount: "9223372036854775807" },
      { orderId: "ord_max_2", customerId: "cust_1", amount: "9223372036854775807" },
    ])

    await expect(
      storage.sql.execute({
        sources: { orders: { dataset: ordersDataset } },
        target: totalsDataset,
        mode: "snapshot",
        sql: ({ orders }) => `
          SELECT customerId, sum(amount) AS total
          FROM ${orders}
          GROUP BY customerId
        `,
      })
    ).rejects.toThrow("out of range")
    expect(await storage.getLatestVersion(totalsDataset.id)).toMatchObject({
      versionId: first.versionId,
    })
    expect(await storage.listVersions(totalsDataset.id)).toHaveLength(1)
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

  test("rejects duplicate keys from snapshot and append SQL transforms", async () => {
    const keyedTarget = defineDataset("analytics.keyed_sql_target", {
      schema: [col("id", "string"), col("value", "string")],
      primaryKey: "id",
    })
    await storage.createDataset(keyedTarget)

    await expect(
      storage.sql.execute({
        sources: {},
        target: keyedTarget,
        mode: "snapshot",
        sql: () => `
          SELECT *
          FROM (VALUES ('row_1', 'first'), ('row_1', 'second')) rows(id, value)
        `,
      })
    ).rejects.toThrow("snapshot source contains duplicate primary key")
    expect(await storage.listVersions(keyedTarget.id)).toEqual([])

    const seed = await storage.sql.execute({
      sources: {},
      target: keyedTarget,
      mode: "snapshot",
      sql: () => "SELECT 'row_1' AS id, 'first' AS value",
    })
    await expect(
      storage.sql.execute({
        sources: {},
        target: keyedTarget,
        mode: "append",
        sql: () => "SELECT 'row_1' AS id, 'second' AS value",
      })
    ).rejects.toThrow("append contains duplicate primary key")

    expect(await storage.listVersions(keyedTarget.id)).toHaveLength(1)
    expect(await storage.getLatestVersion(keyedTarget.id)).toMatchObject({
      versionId: seed.versionId,
    })
    await expect(collectRows(storage.readRows({ datasetId: keyedTarget.id }))).resolves.toEqual([
      { id: "row_1", value: "first" },
    ])
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

  describe("column lineage", () => {
    const pipeline = { kind: "pipeline", id: "customer-insights", stepId: "aggregate" } as const
    const customerRef = (column: string) => ({ datasetId: customersDataset.id, column })
    const orderRef = (column: string) => ({ datasetId: ordersDataset.id, column })

    const insightsSql: SqlTransformBody<"duckdb"> = ({ customers, orders }) => `
      SELECT
        c.customerId,
        count(o.orderId)::BIGINT AS orders,
        sum(o.amount)::BIGINT AS revenue
      FROM ${customers} c
      LEFT JOIN ${orders} o ON o.customerId = c.customerId
      GROUP BY c.customerId
      ORDER BY c.customerId
    `
    // A column lists only what its values add to what decides the rows.
    const insightsLineage = {
      rows: [customerRef("customerId"), orderRef("customerId")],
      columns: {
        customerId: [],
        orders: [orderRef("orderId")],
        revenue: [orderRef("amount")],
      },
    }

    async function seedSources(): Promise<void> {
      await commitRows(storage, customersDataset, [
        { customerId: "cust_1", name: "Ada" },
        { customerId: "cust_2", name: "Grace" },
      ])
      await commitRows(storage, ordersDataset, [
        { orderId: "ord_1", customerId: "cust_1", amount: 10 },
        { orderId: "ord_2", customerId: "cust_2", amount: 20 },
      ])
    }

    function executeInsights(
      sql: SqlTransformBody<"duckdb">,
      producer: DatasetProducer = { ...pipeline, runId: "run_1" }
    ) {
      return storage.sql.execute({
        sources: {
          customers: { dataset: customersDataset },
          orders: { dataset: ordersDataset },
        },
        target: customerInsightsDataset,
        mode: "snapshot",
        producer,
        sql,
      })
    }

    test("records lineage on the committed version and reads it back", async () => {
      await seedSources()

      const version = await executeInsights(insightsSql)
      expect(version.producer).toEqual({ ...pipeline, runId: "run_1" })
      expect(version.lineage).toEqual(insightsLineage)

      const read = (versions: readonly DatasetVersion[]) =>
        versions.find((candidate) => candidate.versionId === version.versionId)?.lineage

      expect(
        (await storage.getVersion(customerInsightsDataset.id, version.versionId))?.lineage
      ).toEqual(insightsLineage)
      expect(read(await storage.listVersions(customerInsightsDataset.id))).toEqual(insightsLineage)

      await storage.close()
      storage = createLocalDuckLakeStorage(rootDir, catalog)

      expect(
        (await storage.getVersion(customerInsightsDataset.id, version.versionId))?.lineage
      ).toEqual(insightsLineage)
      expect(read(await storage.listVersions(customerInsightsDataset.id))).toEqual(insightsLineage)
    })

    // Regression proof: record the SQL's own lineage without resolving it through the source
    // versions. The output then loses the upstream columns its sources were computed from.
    test("resolves the lineage through the source versions it reads", async () => {
      const raw = (column: string) => ({ datasetId: "raw.erp.extract", column })
      const totalsDataset = defineDataset("analytics.customer_totals", {
        schema: [col("customerId", "string"), col("total", "int64")],
      })
      await storage.createDataset(totalsDataset)

      const writeOrders = async (lineage?: DatasetColumnLineage) => {
        const write = await storage.beginWrite({
          dataset: ordersDataset,
          producer: { kind: "pipeline", id: "orders", stepId: "extract" },
          lineage,
        })
        await write.writeRows([{ orderId: "ord_1", customerId: "cust_1", amount: 10 }])
        return write.commit()
      }

      const executeTotals = () =>
        storage.sql.execute({
          sources: { orders: { dataset: ordersDataset } },
          target: totalsDataset,
          mode: "snapshot",
          producer: { ...pipeline, runId: "run_1" },
          sql: ({ orders }) =>
            `SELECT customerId, sum(amount)::BIGINT AS total FROM ${orders} GROUP BY customerId`,
        })

      await writeOrders({
        rows: [raw("tenant")],
        columns: {
          orderId: [raw("id")],
          customerId: [raw("customer")],
          amount: [raw("amount_cents")],
        },
      })

      expect((await executeTotals()).lineage).toEqual({
        rows: [raw("customer"), raw("tenant"), orderRef("customerId")],
        columns: {
          customerId: [],
          total: [raw("amount_cents"), orderRef("amount")],
        },
      })

      // A source version that recorded no lineage could hold anything, and so could the output.
      const unanalyzed = await writeOrders()
      expect((await executeTotals()).lineage).toEqual({
        unknown: `version '${unanalyzed.versionId}' of '${ordersDataset.id}' recorded no column lineage`,
      })
    })

    // Regression proof: compare only inputs in the coordinator's no-op branch. The second
    // execute then reuses the first version, which keeps the lineage of SQL that no longer runs.
    test("creates a new version when only the lineage changes", async () => {
      await seedSources()
      const first = await executeInsights(insightsSql)

      const rewritten = await executeInsights(
        ({ customers, orders }) => `
        SELECT
          c.customerId,
          count(o.orderId)::BIGINT AS orders,
          sum(o.amount + 0 * length(c.name))::BIGINT AS revenue
        FROM ${customers} c
        LEFT JOIN ${orders} o ON o.customerId = c.customerId
        GROUP BY c.customerId
        ORDER BY c.customerId
      `
      )

      expect(rewritten.outcome).toBe("created")
      expect(rewritten.versionId).not.toBe(first.versionId)
      expect(rewritten.lineage).toMatchObject({
        columns: { revenue: [customerRef("name"), orderRef("amount")] },
      })
      expect(
        await collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
      ).toEqual([
        { customerId: "cust_1", orders: "1", revenue: "10" },
        { customerId: "cust_2", orders: "1", revenue: "20" },
      ])

      const repeated = await executeInsights(insightsSql)
      expect(repeated.outcome).toBe("created")
      expect(repeated.lineage).toEqual(insightsLineage)
      expect((await executeInsights(insightsSql)).outcome).toBe("unchanged")
    })

    // Regression proof: record no lineage for unanalyzed SQL whatever its producer. A transform
    // outside pipelines then reads as depending on its own columns only.
    test("executes SQL it cannot analyze and records no lineage", async () => {
      const totals = (id: string) =>
        defineDataset(id, {
          schema: [col("customerId", "string"), col("total", "int64", { nullable: true })],
        })
      const totalsDataset = totals("analytics.customer_totals")
      const unattributedDataset = totals("analytics.unattributed_totals")

      await storage.createDataset(totalsDataset)
      await storage.createDataset(unattributedDataset)
      await seedSources()

      const executePivot = (target: DatasetDefinition, producer?: DatasetProducer) =>
        storage.sql.execute({
          sources: { orders: { dataset: ordersDataset } },
          target,
          mode: "snapshot",
          producer,
          sql: ({ orders }) => `
            SELECT customerId, "ord_1"::BIGINT AS total
            FROM (PIVOT ${orders} ON orderId IN ('ord_1') USING sum(amount) GROUP BY customerId)
            ORDER BY customerId
          `,
        })

      const version = await executePivot(totalsDataset, { ...pipeline, runId: "run_1" })
      expect(version.producer).toEqual({ ...pipeline, runId: "run_1" })
      expect(version.lineage).toBeUndefined()
      expect(await collectRows(storage.readRows({ datasetId: totalsDataset.id }))).toEqual([
        { customerId: "cust_1", total: "10" },
        { customerId: "cust_2", total: null },
      ])

      // Outside pipelines, a write without lineage would depend on its own columns only.
      expect((await executePivot(unattributedDataset)).lineage).toEqual({
        unknown: `a SQL transform into '${unattributedDataset.id}' could not be analyzed`,
      })
    })

    // Regression proof: build the analysis tables from today's definitions instead of the pinned
    // version's schema. `label` then resolves to the column added after that version rather than
    // to the lateral alias that runs, and `shout` loses its dependency on `name`.
    test("binds the pinned version's schema, where a later column would capture an alias", async () => {
      const pinned = await commitRows(storage, customersDataset, [
        { customerId: "cust_1", name: "Ada" },
      ])

      await storage.createDataset(
        defineDataset(customersDataset.id, {
          schema: [...customersDataset.schema.columns, col("label", "string", { nullable: true })],
        })
      )

      const labelsDataset = defineDataset("analytics.customer_labels", {
        schema: [col("customerId", "string"), col("label", "string"), col("shout", "string")],
      })
      await storage.createDataset(labelsDataset)

      const version = await storage.sql.execute({
        sources: { customers: { dataset: customersDataset, versionId: pinned.versionId } },
        target: labelsDataset,
        mode: "snapshot",
        producer: { ...pipeline, runId: "run_1" },
        sql: ({ customers }) => `
          SELECT customerId, upper(name) AS label, label || '!' AS shout FROM ${customers}
        `,
      })

      expect(version.lineage).toEqual({
        rows: [],
        columns: {
          customerId: [customerRef("customerId")],
          label: [customerRef("name")],
          shout: [customerRef("name")],
        },
      })
      expect(await collectRows(storage.readRows({ datasetId: labelsDataset.id }))).toEqual([
        { customerId: "cust_1", label: "ADA", shout: "ADA!" },
      ])
    })

    /** Runs with the analysis reading `pinnedSchema(schema)` as each source's version schema. */
    async function withPinnedSchema<T>(
      pinnedSchema: (schema: DatasetSchema) => DatasetSchema,
      run: () => Promise<T>
    ): Promise<T> {
      const sourceIds = new Set<string>([customersDataset.id, ordersDataset.id])
      const datasets = (storage as unknown as DuckLakeStorageInternals).datasets
      const getSchemasAtSnapshots = datasets.getDatasetSchemasAtSnapshots.bind(datasets)

      datasets.getDatasetSchemasAtSnapshots = async (runtime, requests) => {
        const schemas = await getSchemasAtSnapshots(runtime, requests)
        return schemas.map((schema, index) =>
          sourceIds.has(requests[index].table.datasetId) ? pinnedSchema(schema) : schema
        )
      }

      try {
        return await run()
      } finally {
        datasets.getDatasetSchemasAtSnapshots = getSchemasAtSnapshots
      }
    }

    // Regression proof: drop the check that the analyzed result has the target's columns. The
    // version then records lineage for a column it does not have.
    test("records no lineage when the analysis tables diverge from what runs", async () => {
      await seedSources()
      const copyDataset = defineDataset("analytics.customer_copy", {
        schema: customersDataset.schema.columns,
      })
      await storage.createDataset(copyDataset)

      const version = await withPinnedSchema(
        (schema) => ({
          columns: [...schema.columns, col("segment", "string", { nullable: true })],
        }),
        () =>
          storage.sql.execute({
            sources: { customers: { dataset: customersDataset } },
            target: copyDataset,
            mode: "snapshot",
            producer: { ...pipeline, runId: "run_1" },
            sql: ({ customers }) => `SELECT * FROM ${customers}`,
          })
      )

      expect(version.producer).toEqual({ ...pipeline, runId: "run_1" })
      expect(version.lineage).toBeUndefined()
    })

    // Regression proof: let a failed read of a source's version schema escape. The transform then
    // fails, although only its lineage could not be analyzed.
    test("executes without lineage when a source's version schema cannot be read", async () => {
      await seedSources()
      const warn = spyOn(console, "warn").mockImplementation(() => {})

      try {
        const version = await withPinnedSchema(
          () => {
            throw new LakeStorageError("[SixbDuckLake] Could not reconstruct schema.")
          },
          () => executeInsights(insightsSql)
        )

        expect(version.producer).toEqual({ ...pipeline, runId: "run_1" })
        expect(version.lineage).toBeUndefined()
        expect(warn).toHaveBeenCalledWith(
          `[SixbDuckLake] SQL transform into dataset '${customerInsightsDataset.id}' records no column lineage: [SixbDuckLake] Could not reconstruct schema.`
        )
      } finally {
        warn.mockRestore()
      }

      expect(
        await collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
      ).toEqual([
        { customerId: "cust_1", orders: "1", revenue: "10" },
        { customerId: "cust_2", orders: "1", revenue: "20" },
      ])
    })

    // Regression proof: let the analysis's own pick check throw. A pick that binds on the lake
    // then fails the transform.
    test("executes without lineage when the analysis cannot build its tables", async () => {
      const namesDataset = defineDataset("analytics.customer_names", {
        schema: [col("name", "string")],
      })
      await storage.createDataset(namesDataset)
      await seedSources()

      const warn = spyOn(console, "warn").mockImplementation(() => {})

      try {
        const version = await withPinnedSchema(
          (schema) => ({ columns: schema.columns.filter((column) => column.name !== "name") }),
          () =>
            storage.sql.execute({
              sources: { customers: { dataset: customersDataset, columns: ["name"] } },
              target: namesDataset,
              mode: "snapshot",
              producer: { ...pipeline, runId: "run_1" },
              sql: ({ customers }) => `SELECT * FROM ${customers} ORDER BY name`,
            })
        )

        expect(version.producer).toEqual({ ...pipeline, runId: "run_1" })
        expect(version.lineage).toBeUndefined()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("picks column 'name'"))
      } finally {
        warn.mockRestore()
      }

      expect(await collectRows(storage.readRows({ datasetId: namesDataset.id }))).toEqual([
        { name: "Ada" },
        { name: "Grace" },
      ])
    })

    test("renders a pick as the only columns the transform can read", async () => {
      const namesDataset = defineDataset("analytics.customer_names", {
        schema: [col("name", "string")],
      })
      await storage.createDataset(namesDataset)
      await seedSources()
      const picked = { customers: { dataset: customersDataset, columns: ["name"] } }

      const version = await storage.sql.execute({
        sources: picked,
        target: namesDataset,
        mode: "snapshot",
        producer: { ...pipeline, runId: "run_1" },
        sql: ({ customers }) => `SELECT * FROM ${customers} ORDER BY name`,
      })

      expect(version.lineage).toEqual({ rows: [customerRef("name")], columns: { name: [] } })

      await expect(
        collectRows(
          storage.sql.preview({
            sources: picked,
            sql: ({ customers }) => `SELECT * FROM ${customers} ORDER BY name`,
          })
        )
      ).resolves.toEqual([{ name: "Ada" }, { name: "Grace" }])
      await expect(
        collectRows(
          storage.sql.preview({
            sources: picked,
            sql: ({ customers }) => `SELECT customerId FROM ${customers}`,
          })
        )
      ).rejects.toThrow('Referenced column "customerId" not found')
      await expect(
        storage.sql.execute({
          sources: { customers: { dataset: customersDataset, columns: ["email"] } },
          target: namesDataset,
          mode: "snapshot",
          sql: ({ customers }) => `SELECT * FROM ${customers}`,
        })
      ).rejects.toThrow(
        "[SixbDuckLake] SQL transform source 'customers' picks column 'email', which dataset 'raw.crm.customers' does not have."
      )
    })

    test("maps sources reading the same dataset to one set of dataset column refs", async () => {
      const previous = await commitRows(storage, ordersDataset, [
        { orderId: "ord_1", customerId: "cust_1", amount: 10 },
      ])
      const latest = await commitRows(storage, ordersDataset, [
        { orderId: "ord_1", customerId: "cust_1", amount: 15 },
      ])

      const deltas = defineDataset("analytics.order_deltas", {
        schema: [col("orderId", "string"), col("delta", "int64")],
      })
      await storage.createDataset(deltas)

      const version = await storage.sql.execute({
        sources: {
          before: { dataset: ordersDataset, versionId: previous.versionId },
          after: { dataset: ordersDataset, versionId: latest.versionId },
        },
        target: deltas,
        mode: "snapshot",
        producer: { ...pipeline, runId: "run_1" },
        sql: ({ before, after }) => `
          SELECT a.orderId, a.amount - b.amount AS delta
          FROM ${after} a JOIN ${before} b USING (orderId)
        `,
      })

      expect(version.lineage).toEqual({
        rows: [orderRef("orderId")],
        columns: { orderId: [], delta: [orderRef("amount")] },
      })
      expect(await collectRows(storage.readRows({ datasetId: deltas.id }))).toEqual([
        { orderId: "ord_1", delta: "5" },
      ])
    })

    test("analyzes a transform on a lake without any version", async () => {
      const unknownDataset = defineDataset("raw.not_created.refunds", {
        schema: [col("orderId", "string"), col("refunded", "decimal")],
      })

      expect(
        await storage.sql.analyze({
          sources: {
            orders: { dataset: ordersDataset, columns: ["orderId", "amount"] },
            refunds: { dataset: unknownDataset },
          },
          sql: ({ orders, refunds }) => `
            SELECT o.orderId, o.amount - coalesce(r.refunded, 0) AS net
            FROM ${orders} o LEFT JOIN ${refunds} r USING (orderId)
          `,
        })
      ).toEqual({
        supported: true,
        lineage: {
          rows: [
            { source: "orders", column: "orderId" },
            { source: "refunds", column: "orderId" },
          ],
          columns: {
            orderId: [{ source: "orders", column: "orderId" }],
            net: [
              { source: "orders", column: "amount" },
              { source: "refunds", column: "refunded" },
            ],
          },
        },
      })
      expect(await storage.listVersions(ordersDataset.id)).toEqual([])
    })
  })

  // Regression: remove the null guard or lineage-only snapshot creation; this test must fail.
  test("guards initial SQL output and advances lineage even when rows stay identical", async () => {
    const target = defineDataset("guarded.sql-output", { schema: customersDataset.schema.columns })
    await storage.createDataset(target)
    const firstSource = await commitRows(storage, customersDataset, [
      { customerId: "one", name: "Ada" },
    ])
    const execute = (versionId: string, expectedLatestVersionId: string | null) =>
      storage.sql.execute({
        sources: { customers: { dataset: customersDataset, versionId } },
        target,
        mode: "snapshot",
        expectedLatestVersionId,
        sql: ({ customers }) => `SELECT customerId, 'Constant' AS name FROM ${customers}`,
      })
    const first = await execute(firstSource.versionId, null)
    expect(first.outcome).toBe("created")
    const nextSource = await commitRows(storage, customersDataset, [
      { customerId: "one", name: "Grace" },
    ])
    const next = await execute(nextSource.versionId, first.versionId)
    expect(next.outcome).toBe("created")
    expect(next.versionId).not.toBe(first.versionId)
    expect(next.inputs).toEqual([
      { datasetId: customersDataset.id, versionId: nextSource.versionId },
    ])
    await expect(execute(firstSource.versionId, first.versionId)).rejects.toThrow("Optimistic")
    await expect(execute(nextSource.versionId, null)).rejects.toThrow("Optimistic")
    const repeated = await execute(nextSource.versionId, next.versionId)
    expect(repeated.outcome).toBe("unchanged")
    expect(repeated.versionId).toBe(next.versionId)
    expect(await collectRows(storage.readRows({ datasetId: target.id }))).toEqual([
      { customerId: "one", name: "Constant" },
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
    const initialEmptyVersion = await storage.sql.execute({
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

    expect(initialEmptyVersion.outcome).toBe("created")
    expect(initialEmptyVersion.rowCount).toBe(0)
    await expect(
      collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
    ).resolves.toEqual([])

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

  test("consumes an initial empty source version and commits an empty target version", async () => {
    const sourceWrite = await storage.beginWrite({ dataset: ordersDataset, mode: "snapshot" })
    const sourceVersion = await sourceWrite.commit()

    const targetVersion = await storage.sql.execute({
      sources: { orders: { dataset: ordersDataset, versionId: sourceVersion.versionId } },
      target: customerInsightsDataset,
      mode: "snapshot",
      sql: ({ orders }) => `
        SELECT
          customerId,
          0::BIGINT AS orders,
          amount AS revenue
        FROM ${orders}
      `,
    })

    expect(targetVersion).toMatchObject({
      outcome: "created",
      mode: "snapshot",
      rowCount: 0,
      inputs: [{ datasetId: ordersDataset.id, versionId: sourceVersion.versionId }],
    })
    await expect(
      collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
    ).resolves.toEqual([])
  })

  test("creates a first version for an empty SQL append", async () => {
    const version = await storage.sql.execute({
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

    expect(version.outcome).toBe("created")
    expect(version.mode).toBe("append")
    await expect(
      collectRows(storage.readRows({ datasetId: customerInsightsDataset.id }))
    ).resolves.toEqual([])
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
