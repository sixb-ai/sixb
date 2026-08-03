import { describe, expect, test } from "bun:test"
import type { DatasetDefinition } from "@sixb/core"
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

    await expect(rejected).rejects.toHaveProperty("code", "storage.lake_failed")
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
    await expect(rejected).rejects.toHaveProperty("code", "storage.lake_failed")
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
    await expect(rejected).rejects.toHaveProperty("code", "storage.lake_failed")
    await expect(rejected).rejects.toThrow("Invalid DuckLake version id")
  })

  test("rejects non-dry-run maintenance in read-only mode", async () => {
    const storage = new DuckLakeStorage({
      catalog: {
        type: "duckdb",
        path: ":memory:",
      },
      readOnly: true,
    })

    try {
      await expect(storage.runMaintenance()).rejects.toThrow("read-only")
    } finally {
      await storage.close()
    }
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

  test("runtime withExclusive blocks normal operations until the callback finishes", async () => {
    const runtime = await createDuckDbRuntime()
    const enteredExclusive = createDeferred<void>()
    const releaseExclusive = createDeferred<void>()

    try {
      await runtime.run("CREATE TEMP TABLE exclusive_rows (id INTEGER)")

      const exclusive = runtime.withExclusive(async (exclusiveRuntime) => {
        await exclusiveRuntime.run("INSERT INTO exclusive_rows VALUES (1)")
        enteredExclusive.resolve()
        await releaseExclusive.promise
        await exclusiveRuntime.run("INSERT INTO exclusive_rows VALUES (2)")
      })

      await withTimeout(enteredExclusive.promise, "exclusive block did not start")

      const blockedQuery = runtime.query("SELECT count(*) AS row_count FROM exclusive_rows")
      expect(await resolvesWithin(blockedQuery, 25)).toBe(false)

      releaseExclusive.resolve()

      await exclusive
      await expect(blockedQuery).resolves.toEqual([{ row_count: 2n }])
    } finally {
      releaseExclusive.resolve()
      await runtime.close()
    }
  })

  test("runtime withExclusive releases the queue after a failed callback", async () => {
    const runtime = await createDuckDbRuntime()

    try {
      await runtime.run("CREATE TEMP TABLE exclusive_failures (id INTEGER)")

      await expect(
        runtime.withExclusive(async (exclusiveRuntime) => {
          await exclusiveRuntime.run("INSERT INTO exclusive_failures VALUES (1)")
          throw new Error("exclusive failure")
        })
      ).rejects.toThrow("exclusive failure")

      await expect(
        runtime.query("SELECT count(*) AS row_count FROM exclusive_failures")
      ).resolves.toEqual([{ row_count: 1n }])
    } finally {
      await runtime.close()
    }
  })

  test("runtime withExclusive waits for active streams", async () => {
    const runtime = await createDuckDbRuntime()
    const enteredExclusive = createDeferred<void>()

    try {
      await runtime.run(
        "CREATE TEMP TABLE stream_rows AS SELECT i::INTEGER AS id FROM range(3) AS t(i)"
      )

      const iterator = runtime
        .streamRows("SELECT id FROM stream_rows ORDER BY id")
        [Symbol.asyncIterator]()
      expect(await iterator.next()).toEqual({ done: false, value: { id: 0 } })

      const exclusive = runtime.withExclusive(async (exclusiveRuntime) => {
        enteredExclusive.resolve()
        await exclusiveRuntime.run("INSERT INTO stream_rows VALUES (99)")
      })

      expect(await resolvesWithin(enteredExclusive.promise, 25)).toBe(false)
      expect(await iterator.next()).toEqual({ done: false, value: { id: 1 } })
      expect(await iterator.next()).toEqual({ done: false, value: { id: 2 } })
      expect(await iterator.next()).toEqual({ done: true, value: undefined })

      await withTimeout(enteredExclusive.promise, "exclusive block did not start after stream")
      await exclusive
      await expect(runtime.query("SELECT count(*) AS row_count FROM stream_rows")).resolves.toEqual(
        [{ row_count: 4n }]
      )
    } finally {
      await runtime.close()
    }
  })
})

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: Timer | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 1_000)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

async function resolvesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timeout: Timer | undefined
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}

function createDeferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })

  return {
    promise,
    resolve: resolve!,
  }
}
