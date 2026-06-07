import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset } from "@sixb/core"
import type { DuckLakeStorage } from "../src"
import type { DuckDbQueryRuntime, DuckDbRuntime } from "../src/internal/duckdb-runtime"
import { createDuckDbRuntime, setupDuckLake } from "../src/internal/duckdb-runtime"
import { encodeDatasetTableName } from "../src/internal/names"
import { quoteSqlString } from "../src/internal/sql"
import { collectRows, createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    attachedRuntime(): Promise<DuckDbRuntime>
  }
}

describe("DuckLakeStorage versions and time travel", () => {
  let rootDir: string
  let storage: DuckLakeStorage

  const ordersDataset = defineDataset("raw.erp.orders", {
    schema: [
      col("orderId", "string"),
      col("customerName", "string"),
      col("orderCount", "int64"),
      col("metadata", "json", { nullable: true }),
    ],
  })

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-versions-"))
    storage = createLocalDuckLakeStorage(rootDir)
    await storage.createDataset(ordersDataset)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  test("hydrates versions and reads historical rows with DuckLake time travel", async () => {
    const snapshotWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
      producer: { kind: "sync", id: "erp-sync", runId: "run_1" },
    })
    await snapshotWrite.writeRows([
      { orderId: "ord_1", customerName: "Ada", orderCount: 1 },
      { orderId: "ord_2", customerName: "Grace", orderCount: 2 },
    ])
    const version1 = await snapshotWrite.commit({ commitMessage: "snapshot orders" })

    const appendWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
      inputs: [{ datasetId: ordersDataset.id, versionId: version1.versionId }],
    })
    await appendWrite.writeRows([{ orderId: "ord_3", customerName: "Katherine", orderCount: 3 }])
    const version2 = await appendWrite.commit({ commitMessage: "append orders" })

    const replacementWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await replacementWrite.writeRows([{ orderId: "ord_9", customerName: "Dorothy", orderCount: 9 }])
    const version3 = await replacementWrite.commit({ commitMessage: "replace orders" })

    expect(await storage.getLatestVersion(ordersDataset.id)).toMatchObject({
      versionId: version3.versionId,
      mode: "snapshot",
      rowCount: 1,
    })
    const appendVersion = await storage.getVersion(ordersDataset.id, version2.versionId)
    expect(appendVersion).toMatchObject({
      versionId: version2.versionId,
      parentVersionId: version1.versionId,
      mode: "append",
      inputs: [{ datasetId: ordersDataset.id, versionId: version1.versionId }],
    })
    expect(appendVersion).not.toHaveProperty("rowCount")

    const versions = await storage.listVersions(ordersDataset.id)
    expect(versions.map((version) => version.versionId)).toEqual([
      version3.versionId,
      version2.versionId,
      version1.versionId,
    ])
    expect(
      (await storage.listVersions(ordersDataset.id, 2)).map((version) => version.versionId)
    ).toEqual([version3.versionId, version2.versionId])

    expect(
      await collectRows(
        storage.readRows({ datasetId: ordersDataset.id, versionId: version1.versionId })
      )
    ).toEqual([
      { orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null },
      { orderId: "ord_2", customerName: "Grace", orderCount: "2", metadata: null },
    ])
    expect(
      await collectRows(
        storage.readRows({
          datasetId: ordersDataset.id,
          versionId: version2.versionId,
          columns: ["orderId"],
          limit: 2,
        })
      )
    ).toEqual([{ orderId: "ord_1" }, { orderId: "ord_2" }])
    expect(await collectRows(storage.readRows({ datasetId: ordersDataset.id }))).toEqual([
      { orderId: "ord_9", customerName: "Dorothy", orderCount: "9", metadata: null },
    ])
  })

  test("reads version metadata without catalog introspection or historical table scans", async () => {
    const snapshotWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await snapshotWrite.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    const version1 = await snapshotWrite.commit()

    const appendWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "append",
      inputs: [{ datasetId: ordersDataset.id, versionId: version1.versionId }],
    })
    await appendWrite.writeRows([{ orderId: "ord_2", customerName: "Grace", orderCount: 2 }])
    const version2 = await appendWrite.commit()
    expect(version2).not.toHaveProperty("rowCount")

    const runtime = await (
      storage as unknown as DuckLakeStorageInternals
    ).connections.attachedRuntime()
    const originalQuery = runtime.query.bind(runtime)
    runtime.query = (async (sql, values) => {
      if (
        /\bduckdb_tables\s*\(/i.test(sql) ||
        /SELECT\s+count\(\*\)\s+AS\s+row_count/i.test(sql) ||
        /DESCRIBE\s+SELECT\s+\*\s+FROM[\s\S]*\bAT\s*\(\s*VERSION\s*=>/i.test(sql)
      ) {
        throw new Error(`Unexpected expensive version metadata read: ${sql}`)
      }

      return originalQuery(sql, values)
    }) satisfies DuckDbQueryRuntime["query"]

    try {
      const versions = await storage.listVersions(ordersDataset.id, 2)
      expect(versions.map((version) => version.versionId)).toEqual([
        version2.versionId,
        version1.versionId,
      ])
      expect(versions[0]).not.toHaveProperty("rowCount")
      expect(versions[1]).toMatchObject({ rowCount: 1 })

      await expect(storage.getLatestVersion(ordersDataset.id)).resolves.toMatchObject({
        versionId: version2.versionId,
      })
      await expect(storage.getVersion(ordersDataset.id, version2.versionId)).resolves.toMatchObject(
        {
          versionId: version2.versionId,
          parentVersionId: version1.versionId,
        }
      )
      await expect(storage.listVersions("missing.dataset")).resolves.toEqual([])
      await expect(storage.getLatestVersion("missing.dataset")).resolves.toBeNull()
    } finally {
      runtime.query = originalQuery
    }
  })

  test("reads limited rows without catalog introspection or streaming", async () => {
    const snapshotWrite = await storage.beginWrite({
      dataset: ordersDataset,
      mode: "snapshot",
    })
    await snapshotWrite.writeRows([
      { orderId: "ord_1", customerName: "Ada", orderCount: 1 },
      { orderId: "ord_2", customerName: "Grace", orderCount: 2 },
    ])
    const version = await snapshotWrite.commit()

    const runtime = await (
      storage as unknown as DuckLakeStorageInternals
    ).connections.attachedRuntime()
    const originalQuery = runtime.query.bind(runtime)
    const originalStreamRows = runtime.streamRows.bind(runtime)
    runtime.query = (async (sql, values) => {
      if (
        /\bduckdb_tables\s*\(/i.test(sql) ||
        /SELECT\s+count\(\*\)\s+AS\s+row_count/i.test(sql) ||
        /DESCRIBE\s+SELECT\s+\*\s+FROM[\s\S]*\bAT\s*\(\s*VERSION\s*=>/i.test(sql)
      ) {
        throw new Error(`Unexpected expensive row read: ${sql}`)
      }

      return originalQuery(sql, values)
    }) satisfies DuckDbQueryRuntime["query"]
    runtime.streamRows = ((sql, values) => {
      void values
      throw new Error(`Unexpected streaming row preview: ${sql}`)
    }) satisfies DuckDbRuntime["streamRows"]

    try {
      await expect(
        collectRows(
          storage.readRows({
            datasetId: ordersDataset.id,
            versionId: version.versionId,
            limit: 1,
          })
        )
      ).resolves.toEqual([
        { orderId: "ord_1", customerName: "Ada", orderCount: "1", metadata: null },
      ])
    } finally {
      runtime.query = originalQuery
      runtime.streamRows = originalStreamRows
    }
  })

  test("discovers data changes and Sixb metadata-only snapshots", async () => {
    await storage.close()

    const runtime = await createDuckDbRuntime()
    try {
      await setupDuckLake(runtime, localDuckLakeOptions(rootDir))

      const tableName = encodeDatasetTableName(ordersDataset.id)
      await runtime.run(
        `INSERT INTO sixb_lake.main.${tableName} VALUES ('raw_1', 'External', 1, NULL)`
      )

      await runtime.run(`COMMENT ON TABLE sixb_lake.main.${tableName} IS 'ignored metadata only'`)

      await runtime.run("BEGIN TRANSACTION")
      await runtime.run(`COMMENT ON TABLE sixb_lake.main.${tableName} IS 'sixb metadata only'`)
      await runtime.run(
        `CALL sixb_lake.set_commit_message('Sixb', 'sixb metadata only', extra_info => ${quoteSqlString(
          JSON.stringify({
            sixb: {
              kind: "datasetVersion",
              datasetId: ordersDataset.id,
              mode: "append",
              rowCount: 999,
            },
          })
        )})`
      )
      await runtime.run("COMMIT")
    } finally {
      await runtime.close()
    }

    storage = createLocalDuckLakeStorage(rootDir)

    const versions = await storage.listVersions(ordersDataset.id)
    expect(versions).toHaveLength(2)
    expect(versions[0]).toMatchObject({
      datasetId: ordersDataset.id,
      mode: "append",
    })
    expect(versions[0]).not.toHaveProperty("rowCount")
    expect(versions[1]).toMatchObject({
      datasetId: ordersDataset.id,
      mode: "append",
    })
    expect(versions[1]).not.toHaveProperty("rowCount")
    expect(await storage.getLatestVersion(ordersDataset.id)).toEqual(versions[0])
    expect(await collectRows(storage.readRows({ datasetId: ordersDataset.id }))).toEqual([
      { orderId: "raw_1", customerName: "External", orderCount: "1", metadata: null },
    ])
  })

  test("rejects data-change snapshots with conflicting Sixb metadata", async () => {
    await storage.close()

    const runtime = await createDuckDbRuntime()
    try {
      await setupDuckLake(runtime, localDuckLakeOptions(rootDir))

      const tableName = encodeDatasetTableName(ordersDataset.id)
      await runtime.run("BEGIN TRANSACTION")
      await runtime.run(
        `INSERT INTO sixb_lake.main.${tableName} VALUES ('raw_1', 'External', 1, NULL)`
      )
      await runtime.run(
        `CALL sixb_lake.set_commit_message('Sixb', 'wrong dataset metadata', extra_info => ${quoteSqlString(
          JSON.stringify({
            sixb: {
              kind: "datasetVersion",
              datasetId: "other.dataset",
              mode: "append",
              rowCount: 1,
            },
          })
        )})`
      )
      await runtime.run("COMMIT")
    } finally {
      await runtime.close()
    }

    storage = createLocalDuckLakeStorage(rootDir)

    await expect(storage.listVersions(ordersDataset.id)).rejects.toThrow(
      "metadata references dataset 'other.dataset'"
    )
  })

  test("returns empty or null results for unknown versions", async () => {
    expect(await storage.listVersions("missing.dataset")).toEqual([])
    expect(await storage.getLatestVersion("missing.dataset")).toBeNull()
    expect(await storage.getVersion(ordersDataset.id, "ducklake:999999")).toBeNull()

    await expect(
      collectRows(storage.readRows({ datasetId: ordersDataset.id, versionId: "ducklake:999999" }))
    ).rejects.toThrow("No committed version found")
  })
})
