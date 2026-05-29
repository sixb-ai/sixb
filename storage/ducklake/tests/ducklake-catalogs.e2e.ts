import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset } from "@pario/core"
import { DuckLakeStorage } from "../src"
import { createDuckDbRuntime, setupDuckLake } from "../src/internal/duckdb-runtime"

const ordersDataset = defineDataset("raw.erp.orders", {
  schema: [col("orderId", "string")],
})

describe("DuckLakeStorage catalog options", () => {
  let rootDir: string
  let storages: DuckLakeStorage[]

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pario-ducklake-catalogs-"))
    storages = []
  })

  afterEach(async () => {
    for (const storage of storages.splice(0)) {
      await storage.close()
    }
    await rm(rootDir, { recursive: true, force: true })
  })

  test("supports SQLite catalogs", async () => {
    const storage = track(
      new DuckLakeStorage({
        catalog: {
          type: "sqlite",
          path: join(rootDir, "metadata.sqlite"),
        },
        dataPath: join(rootDir, "data"),
      })
    )

    await storage.createDataset(ordersDataset)
    expect(await storage.listDatasets()).toEqual([ordersDataset])
  })

  test("supports custom catalog URIs", async () => {
    const storage = track(
      new DuckLakeStorage({
        catalog: {
          type: "custom",
          uri: join(rootDir, "metadata.ducklake"),
        },
        dataPath: join(rootDir, "data"),
      })
    )

    await storage.createDataset(ordersDataset)
    expect(await storage.getDataset(ordersDataset.id)).toEqual(ordersDataset)
  })

  test("honors setupSql before attach", async () => {
    const runtime = await createDuckDbRuntime()
    try {
      await setupDuckLake(runtime, {
        catalog: {
          type: "duckdb",
          path: join(rootDir, "metadata.ducklake"),
        },
        dataPath: join(rootDir, "data"),
        setupSql: ["CREATE MACRO pario_setup_value() AS 42"],
      })

      const [row] = await runtime.query("SELECT pario_setup_value() AS value")
      expect(row?.value).toBe(42)
    } finally {
      await runtime.close()
    }
  })

  test("honors readOnly for existing catalogs", async () => {
    const writable = track(
      new DuckLakeStorage({
        catalog: {
          type: "duckdb",
          path: join(rootDir, "metadata.ducklake"),
        },
        dataPath: join(rootDir, "data"),
      })
    )
    await writable.createDataset(ordersDataset)
    await writable.close()
    storages = storages.filter((storage) => storage !== writable)

    const readOnly = track(
      new DuckLakeStorage({
        catalog: {
          type: "duckdb",
          path: join(rootDir, "metadata.ducklake"),
        },
        readOnly: true,
        createIfNotExists: false,
      })
    )

    expect(await readOnly.listDatasets()).toEqual([ordersDataset])
    await expect(
      readOnly.createDataset(
        defineDataset("raw.erp.customers", {
          schema: [col("customerId", "string")],
        })
      )
    ).rejects.toThrow()
  })

  test("honors createIfNotExists false", async () => {
    const storage = track(
      new DuckLakeStorage({
        catalog: {
          type: "duckdb",
          path: join(rootDir, "missing.ducklake"),
        },
        dataPath: join(rootDir, "data"),
        createIfNotExists: false,
      })
    )

    await expect(storage.listDatasets()).rejects.toThrow("does not exist")
    await storage.close()
    await storage.close()
  })

  test("recovers after a failed runtime initialization", async () => {
    const storage = track(
      new DuckLakeStorage({
        catalog: {
          type: "duckdb",
          path: join(rootDir, "metadata.ducklake"),
        },
        dataPath: join(rootDir, "data"),
        setupSql: ["THIS IS NOT VALID SQL"],
      })
    )

    await expect(storage.listDatasets()).rejects.toThrow()

    const recovered = track(
      new DuckLakeStorage({
        catalog: {
          type: "duckdb",
          path: join(rootDir, "metadata.ducklake"),
        },
        dataPath: join(rootDir, "data"),
      })
    )

    await recovered.createDataset(ordersDataset)
    expect(await recovered.listDatasets()).toEqual([ordersDataset])
  })

  test("close is safe after failed runtime initialization", async () => {
    const storage = track(
      new DuckLakeStorage({
        catalog: {
          type: "duckdb",
          path: join(rootDir, "metadata.ducklake"),
        },
        dataPath: join(rootDir, "data"),
        setupSql: ["THIS IS NOT VALID SQL"],
      })
    )

    await expect(storage.listDatasets()).rejects.toThrow()
    await storage.close()
    await storage.close()
  })

  function track(storage: DuckLakeStorage): DuckLakeStorage {
    storages.push(storage)
    return storage
  }
})
