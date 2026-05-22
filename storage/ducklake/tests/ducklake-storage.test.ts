import { describe, expect, test } from "bun:test"
import { type DatasetDefinition, LakeStorageError } from "@pario/core"
import { DuckLakeStorage } from "../src"

describe("DuckLakeStorage", () => {
  test("rejects schemaless dataset definitions", async () => {
    const storage = new DuckLakeStorage({
      catalog: {
        type: "duckdb",
        path: ":memory:",
      },
    })

    const rejected = storage.createDataset({
      kind: "dataset",
      id: "raw.erp.orders",
    } as DatasetDefinition)

    await expect(rejected).rejects.toBeInstanceOf(LakeStorageError)
    await expect(rejected).rejects.toThrow(
      "Dataset 'raw.erp.orders' requires a schema for DuckLake storage"
    )
  })

  test("close is idempotent and rejects new operations", async () => {
    const storage = new DuckLakeStorage({
      catalog: {
        type: "duckdb",
        path: ":memory:",
      },
    })

    await storage.close()
    await storage.close()

    const rejected = storage.listDatasets()
    await expect(rejected).rejects.toBeInstanceOf(LakeStorageError)
    await expect(rejected).rejects.toThrow("closed")
  })

  test("validates version ids before opening a DuckLake runtime", async () => {
    const storage = new DuckLakeStorage({
      catalog: {
        type: "duckdb",
        path: ":memory:",
      },
    })

    const rejected = storage.getVersion("missing.dataset", "not-a-ducklake-version")
    await expect(rejected).rejects.toBeInstanceOf(LakeStorageError)
    await expect(rejected).rejects.toThrow("Invalid DuckLake version id")
  })
})
