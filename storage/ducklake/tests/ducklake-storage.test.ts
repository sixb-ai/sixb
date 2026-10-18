import { describe, expect, test } from "bun:test"
import type { DatasetDefinition } from "@sixb/core"
import { LakeStorageError } from "@sixb/core/lake-storage"
import { DuckLakeStorage } from "../src"
import { createDuckDbRuntime } from "../src/internal/duckdb-runtime"

describe("DuckLakeStorage", () => {
  test("rejects invalid streaming limits before opening the engine", () => {
    // Red check: remove the maxStreamingReads validation in the connection manager.
    for (const maxStreamingReads of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new DuckLakeStorage({
            catalog: { type: "duckdb", path: ":memory:" },
            maxStreamingReads,
          })
      ).toThrow("maxStreamingReads must be a positive integer")
    }
  })

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
      "[SixbDuckLake] Dataset definitions must declare a schema."
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
    // Without a spill directory, closing does no I/O: one turn settles a close that does not wait.
    const runtime = await createDuckDbRuntime({ config: { temp_directory: "" } })
    const release = createDeferred<void>()
    const accepted = runtime.withExclusive(async (exclusiveRuntime) => {
      await release.promise
      return exclusiveRuntime.query("SELECT 42 AS answer")
    })
    let closed = false
    const close = runtime.close().then(() => {
      closed = true
    })

    await expect(runtime.query("SELECT 1")).rejects.toThrow("closed")
    // Red check: drop the wait for accepted work from the runtime's close. It then closes the
    // connection under the accepted operation and settles here.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(closed).toBe(false)

    release.resolve()
    expect(await accepted).toEqual([{ answer: 42 }])
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

  test("runtime withExclusive can write during an independent read", async () => {
    const runtime = await createDuckDbRuntime()
    const enteredExclusive = createDeferred<void>()

    try {
      await runtime.run("CREATE TABLE stream_rows AS SELECT i::INTEGER AS id FROM range(3) AS t(i)")

      const reader = await runtime.openReader("SELECT id FROM stream_rows ORDER BY id")
      const iterator = reader.rows()[Symbol.asyncIterator]()
      expect(await iterator.next()).toEqual({ done: false, value: { id: 0 } })

      const exclusive = runtime.withExclusive(async (exclusiveRuntime) => {
        enteredExclusive.resolve()
        await exclusiveRuntime.run("INSERT INTO stream_rows VALUES (99)")
      })

      await withTimeout(enteredExclusive.promise, "exclusive block did not start during the read")
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
