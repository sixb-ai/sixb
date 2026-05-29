import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset } from "@pario/core"
import type { DuckLakeStorage } from "../src"
import { createDuckDbRuntime, setupDuckLake } from "../src/internal/duckdb-runtime"
import { encodeDatasetTableName } from "../src/internal/names"
import { quoteSqlString } from "../src/internal/sql"
import { createLocalDuckLakeStorage, localDuckLakeOptions } from "./test-utils"

interface DuckLakeStorageInternals {
  readonly connections: {
    attachedRuntime(): Promise<{
      query: (
        sql: string,
        values?: readonly unknown[]
      ) => Promise<readonly Record<string, unknown>[]>
    }>
  }
}

async function captureCatalogStateQueries(
  storage: DuckLakeStorage,
  datasetIds: readonly string[]
): Promise<{ queries: string[] }> {
  // Warm the attachment so wrapping targets the runtime the bulk read reuses.
  await storage.listDatasetCatalogState(datasetIds)

  const internals = storage as unknown as DuckLakeStorageInternals
  const runtime = await internals.connections.attachedRuntime()
  const originalQuery = runtime.query.bind(runtime)
  const queries: string[] = []
  runtime.query = async (sql, values) => {
    queries.push(sql)
    return originalQuery(sql, values)
  }

  await storage.listDatasetCatalogState(datasetIds)
  runtime.query = originalQuery
  return { queries }
}

describe("DuckLakeStorage bulk catalog state", () => {
  let rootDir: string
  let storage: DuckLakeStorage

  const ordersDataset = defineDataset("raw.erp.orders", {
    schema: [col("orderId", "string"), col("customerName", "string"), col("orderCount", "int64")],
  })

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pario-ducklake-catalog-"))
    storage = createLocalDuckLakeStorage(rootDir)
  })

  afterEach(async () => {
    await storage.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  test("returns materialized false for registered-but-uncreated datasets", async () => {
    await storage.createDataset(ordersDataset)

    const state = await storage.listDatasetCatalogState([ordersDataset.id, "raw.not.created"])

    expect(state).toEqual([
      { datasetId: ordersDataset.id, materialized: true, latestVersion: null },
      { datasetId: "raw.not.created", materialized: false, latestVersion: null },
    ])
  })

  // Performance regression: the bulk read must not fan out into one query per
  // dataset. Many materialized datasets are resolved with the same small,
  // bounded set of metadata queries as a few would need.
  test("resolves many datasets with a bounded, count-independent query set", async () => {
    const datasetCount = 30
    const datasetIds: string[] = []
    for (let index = 0; index < datasetCount; index += 1) {
      const dataset = defineDataset(`raw.erp.dataset_${index}`, {
        schema: [col("id", "string"), col("amount", "int64")],
      })
      await storage.createDataset(dataset)
      const write = await storage.beginWrite({ dataset, mode: "snapshot" })
      await write.writeRows([
        { id: "a", amount: 1 },
        { id: "b", amount: 2 },
      ])
      await write.commit()
      datasetIds.push(dataset.id)
    }

    const { queries } = await captureCatalogStateQueries(storage, [...datasetIds, "raw.missing"])
    const state = await storage.listDatasetCatalogState([...datasetIds, "raw.missing"])

    for (const datasetId of datasetIds) {
      const item = state.find((entry) => entry.datasetId === datasetId)
      expect(item?.materialized).toBe(true)
      expect(item?.latestVersion?.datasetId).toBe(datasetId)
      expect(item?.latestVersion?.mode).toBe("snapshot")
      expect(item?.latestVersion?.rowCount).toBe(2)
      expect(item?.latestVersion?.versionId).toMatch(/^ducklake:\d+$/)
    }

    expect(state.find((entry) => entry.datasetId === "raw.missing")).toEqual({
      datasetId: "raw.missing",
      materialized: false,
      latestVersion: null,
    })

    // Table-id map + one snapshot-batch scan (candidates + file flags). A
    // per-dataset getLatestVersion loop would scale with datasetCount instead.
    expect(queries.length).toBeLessThanOrEqual(3)
    for (const sql of queries) {
      expect(sql.toLowerCase()).not.toContain("count(*)")
      expect(sql).not.toContain("AT (VERSION")
    }
  })

  test("carries row counts from Pario commit metadata, omitting unguarded appends", async () => {
    await storage.createDataset(ordersDataset)
    const snapshot = await storage.beginWrite({ dataset: ordersDataset, mode: "snapshot" })
    await snapshot.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    const snapshotVersion = await snapshot.commit()

    // A guarded append commits an exact row count in its Pario metadata.
    const append = await storage.beginWrite({ dataset: ordersDataset, mode: "append" })
    await append.writeRows([{ orderId: "ord_2", customerName: "Grace", orderCount: 2 }])
    await append.commit({ expectedLatestVersionId: snapshotVersion.versionId })

    const [guarded] = await storage.listDatasetCatalogState([ordersDataset.id])
    expect(guarded).toMatchObject({
      datasetId: ordersDataset.id,
      materialized: true,
      latestVersion: expect.objectContaining({ mode: "append", rowCount: 2 }),
    })

    // An unguarded append intentionally omits its row count so the bulk read
    // never falls back to count(*). The summary must leave rowCount undefined.
    const unguarded = await storage.beginWrite({ dataset: ordersDataset, mode: "append" })
    await unguarded.writeRows([{ orderId: "ord_3", customerName: "Katherine", orderCount: 3 }])
    await unguarded.commit()

    const [item] = await storage.listDatasetCatalogState([ordersDataset.id])
    expect(item?.latestVersion?.mode).toBe("append")
    expect(item?.latestVersion?.rowCount).toBeUndefined()
  })

  test("surfaces a metadata-only schema version as the latest", async () => {
    await storage.createDataset(ordersDataset)
    const write = await storage.beginWrite({ dataset: ordersDataset, mode: "snapshot" })
    await write.writeRows([{ orderId: "ord_1", customerName: "Ada", orderCount: 1 }])
    await write.commit()

    // Schema evolution commits a metadata-only snapshot newer than the data write.
    await storage.createDataset(
      defineDataset(ordersDataset.id, {
        schema: [
          col("orderId", "string"),
          col("customerName", "string"),
          col("orderCount", "int64"),
          col("region", "string", { nullable: true }),
        ],
      })
    )

    const [item] = await storage.listDatasetCatalogState([ordersDataset.id])
    expect(item).toMatchObject({
      datasetId: ordersDataset.id,
      materialized: true,
      latestVersion: expect.objectContaining({ mode: "schema" }),
    })
    expect(item?.latestVersion?.rowCount).toBeUndefined()
  })

  test("fails loudly on conflicting Pario metadata", async () => {
    await storage.createDataset(ordersDataset)
    await storage.close()

    const runtime = await createDuckDbRuntime()
    try {
      await setupDuckLake(runtime, localDuckLakeOptions(rootDir))
      const tableName = encodeDatasetTableName(ordersDataset.id)
      await runtime.run("BEGIN TRANSACTION")
      await runtime.run(`INSERT INTO pario_lake.main.${tableName} VALUES ('raw_1', 'External', 1)`)
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
    await expect(storage.listDatasetCatalogState([ordersDataset.id])).rejects.toThrow(
      "metadata references dataset 'other.dataset'"
    )
  })

  test("returns an empty result for an empty request", async () => {
    expect(await storage.listDatasetCatalogState([])).toEqual([])
  })
})
