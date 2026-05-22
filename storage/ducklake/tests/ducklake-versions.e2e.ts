import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset } from "@pario/core"
import type { DuckLakeStorage } from "../src"
import { createDuckDbRuntime, setupDuckLake } from "../src/internal/duckdb-runtime"
import { encodeDatasetTableName } from "../src/internal/names"
import { quoteSqlString } from "../src/internal/sql"
import { collectRows, createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

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
    rootDir = await mkdtemp(join(tmpdir(), "pario-ducklake-versions-"))
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
    expect(await storage.getVersion(ordersDataset.id, version2.versionId)).toMatchObject({
      versionId: version2.versionId,
      parentVersionId: version1.versionId,
      mode: "append",
      inputs: [{ datasetId: ordersDataset.id, versionId: version1.versionId }],
      rowCount: 3,
    })

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

  test("discovers data changes and Pario metadata-only snapshots", async () => {
    await storage.close()

    const runtime = await createDuckDbRuntime()
    try {
      await setupDuckLake(runtime, localDuckLakeOptions(rootDir))

      const tableName = encodeDatasetTableName(ordersDataset.id)
      await runtime.run(
        `INSERT INTO pario_lake.main.${tableName} VALUES ('raw_1', 'External', 1, NULL)`
      )

      await runtime.run(`COMMENT ON TABLE pario_lake.main.${tableName} IS 'ignored metadata only'`)

      await runtime.run("BEGIN TRANSACTION")
      await runtime.run(`COMMENT ON TABLE pario_lake.main.${tableName} IS 'pario metadata only'`)
      await runtime.run(
        `CALL pario_lake.set_commit_message('Pario', 'pario metadata only', extra_info => ${quoteSqlString(
          JSON.stringify({
            pario: {
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
      rowCount: 1,
    })
    expect(versions[1]).toMatchObject({
      datasetId: ordersDataset.id,
      mode: "append",
      rowCount: 1,
    })
    expect(await storage.getLatestVersion(ordersDataset.id)).toEqual(versions[0])
    expect(await collectRows(storage.readRows({ datasetId: ordersDataset.id }))).toEqual([
      { orderId: "raw_1", customerName: "External", orderCount: "1", metadata: null },
    ])
  })

  test("rejects data-change snapshots with conflicting Pario metadata", async () => {
    await storage.close()

    const runtime = await createDuckDbRuntime()
    try {
      await setupDuckLake(runtime, localDuckLakeOptions(rootDir))

      const tableName = encodeDatasetTableName(ordersDataset.id)
      await runtime.run("BEGIN TRANSACTION")
      await runtime.run(
        `INSERT INTO pario_lake.main.${tableName} VALUES ('raw_1', 'External', 1, NULL)`
      )
      await runtime.run(
        `CALL pario_lake.set_commit_message('Pario', 'wrong dataset metadata', extra_info => ${quoteSqlString(
          JSON.stringify({
            pario: {
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
