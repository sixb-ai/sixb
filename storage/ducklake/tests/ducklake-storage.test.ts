import { describe, expect, test } from "bun:test"
import { type DatasetDefinition, LakeStorageError } from "@pario/core"
import { DuckLakeStorage } from "../src"
import { createDuckDbRuntime } from "../src/internal/duckdb-runtime"

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

  test("runtime close waits for accepted operations and rejects new operations", async () => {
    const runtime = await createDuckDbRuntime()
    const running = runtime.query("SELECT sum(sin(i)) AS total FROM range(50000000) AS t(i)")
    const close = runtime.close()

    await expect(runtime.query("SELECT 1")).rejects.toThrow("closed")
    await expect(
      Promise.race([running.then(() => "operation"), close.then(() => "close")])
    ).resolves.toBe("operation")
    await close
    await expect(runtime.query("SELECT 1")).rejects.toThrow("closed")
  })

  test("runtime withAppender closes staged rows before the next operation", async () => {
    const runtime = await createDuckDbRuntime()

    try {
      await runtime.run("CREATE TEMP TABLE staged_rows (id VARCHAR, count BIGINT)")
      await runtime.withAppender("staged_rows", (appender) => {
        appender.appendVarchar("ord_1")
        appender.appendBigInt(1n)
        appender.endRow()
      })

      await expect(runtime.query("SELECT count(*) AS row_count FROM staged_rows")).resolves.toEqual(
        [{ row_count: 1n }]
      )
    } finally {
      await runtime.close()
    }
  })
})
