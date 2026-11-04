import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { col, defineDataset } from "@sixb/core"
import { DuckLakeStorage } from "../src"
import {
  createDuckDbRuntime,
  type DuckDbRuntime,
  setupDuckLake,
} from "../src/internal/duckdb-runtime"
import { DuckLakeConnectionManager } from "../src/internal/ducklake-connection-manager"

const ordersDataset = defineDataset("raw.erp.orders", {
  schema: [col("orderId", "string")],
})

describe("DuckLakeStorage catalog options", () => {
  let rootDir: string
  let storages: DuckLakeStorage[]

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-catalogs-"))
    storages = []
  })

  afterEach(async () => {
    for (const storage of storages.splice(0)) {
      await storage.close()
    }
    await rm(rootDir, { recursive: true, force: true })
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
        setupSql: ["CREATE MACRO sixb_setup_value() AS 42"],
      })

      const [row] = await runtime.query("SELECT sixb_setup_value() AS value")
      expect(row?.value).toBe(42)
    } finally {
      await runtime.close()
    }
  })

  // Regression proof: remove assertDuckLakeExtensionVersion from setupDuckLake. The lake then
  // attaches with whatever DuckLake build the runtime reports.
  test("refuses a DuckLake extension build it is not pinned to, before attaching", async () => {
    const runtime = await createDuckDbRuntime()
    const statements: string[] = []

    // The real runtime, except that it reports another DuckLake build, as DuckDB would after its
    // extension repository replaced the build a deploy downloads.
    const otherBuild: DuckDbRuntime = Object.create(runtime, {
      run: {
        value: (sql: string) => {
          statements.push(sql)
          return runtime.run(sql)
        },
      },
      query: {
        value: async (sql: string) =>
          sql.includes("duckdb_extensions()")
            ? [{ extension_version: "0123abcd" }]
            : runtime.query(sql),
      },
    })

    try {
      const setup = setupDuckLake(otherBuild, {
        catalog: { type: "duckdb", path: join(rootDir, "metadata.ducklake") },
        dataPath: join(rootDir, "data"),
      })

      expect(String(await setup.catch((error) => error))).toContain(
        "DuckLake extension build '0123abcd' is loaded, but this provider requires build"
      )
      expect(statements.some((sql) => sql.startsWith("ATTACH"))).toBe(false)
    } finally {
      await runtime.close()
    }
  })

  test("reapplies insertion-order preservation after setupSql", async () => {
    const manager = new DuckLakeConnectionManager({
      catalog: {
        type: "duckdb",
        path: join(rootDir, "ordered-metadata.ducklake"),
      },
      dataPath: join(rootDir, "ordered-data"),
      setupSql: ["SET preserve_insertion_order = false"],
    })

    try {
      const runtime = await manager.runtime()
      const [row] = await runtime.query(
        "SELECT current_setting('preserve_insertion_order')::BOOLEAN AS enabled"
      )
      expect(row?.enabled).toBe(true)
    } finally {
      await manager.close()
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
