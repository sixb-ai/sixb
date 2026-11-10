import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import { DuckLakeStorage } from "../src"
import { createDuckDbRuntime, type DuckDbRuntime } from "../src/internal/duckdb-runtime"

const IDLE_MS = 1_000

/** Lets the runtime's queue bookkeeping, which runs after each result settles, catch up. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

async function setting(runtime: DuckDbRuntime, name: string): Promise<unknown> {
  const [row] = await runtime.query("SELECT current_setting(?) AS value", [name])
  return row?.value
}

describe("DuckDB runtime memory", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test("flushes the allocator at 32 MB unless duckdb.config sets a threshold", async () => {
    // Red check: drop DUCKDB_CONFIG_DEFAULTS from createDuckDbRuntime; DuckDB reports 488.2 MiB (512 MB).
    const defaults = await createDuckDbRuntime({ config: { temp_directory: "" } })
    const configured = await createDuckDbRuntime({
      config: { temp_directory: "", allocator_bulk_deallocation_flush_threshold: "256MB" },
    })
    try {
      expect(await setting(defaults, "allocator_bulk_deallocation_flush_threshold")).toBe(
        "30.5 MiB"
      )
      expect(await setting(configured, "allocator_bulk_deallocation_flush_threshold")).toBe(
        "244.1 MiB"
      )
    } finally {
      await defaults.close()
      await configured.close()
    }
  })

  test("releases memory once the runtime has been idle, and again only after new work", async () => {
    // Red check: remove the scheduleIdleRelease() call in enqueue; no release ever happens.
    jest.useFakeTimers()
    const runtime = await createDuckDbRuntime({
      config: { temp_directory: "" },
      releaseMemoryAfterIdleMs: IDLE_MS,
    })
    const release = spyOn(runtime, "releaseMemory")
    try {
      await runtime.query("SELECT 1")
      await settle()
      jest.advanceTimersByTime(IDLE_MS - 1)
      expect(release).toHaveBeenCalledTimes(0)
      jest.advanceTimersByTime(1)
      expect(release).toHaveBeenCalledTimes(1)
      await release.mock.results[0]?.value
      await settle()

      // The release itself is not work that needs releasing.
      jest.advanceTimersByTime(IDLE_MS * 10)
      expect(release).toHaveBeenCalledTimes(1)

      await runtime.query("SELECT 2")
      await settle()
      jest.advanceTimersByTime(IDLE_MS)
      expect(release).toHaveBeenCalledTimes(2)
      await release.mock.results[1]?.value
    } finally {
      await runtime.close()
    }
  })

  test("work before the delay postpones the release", async () => {
    // Red check: remove cancelIdleRelease() from enqueue; the first timer fires at 1000 ms.
    jest.useFakeTimers()
    const runtime = await createDuckDbRuntime({
      config: { temp_directory: "" },
      releaseMemoryAfterIdleMs: IDLE_MS,
    })
    const release = spyOn(runtime, "releaseMemory")
    try {
      await runtime.query("SELECT 1")
      await settle()
      jest.advanceTimersByTime(600)
      await runtime.query("SELECT 2")
      await settle()
      jest.advanceTimersByTime(600)
      expect(release).toHaveBeenCalledTimes(0)
      jest.advanceTimersByTime(400)
      expect(release).toHaveBeenCalledTimes(1)
      await release.mock.results[0]?.value
    } finally {
      await runtime.close()
    }
  })

  test("waits for open readers to close", async () => {
    // Red check: drop the readers.size condition in scheduleIdleRelease, or cancelIdleRelease()
    // from enqueue (the timer the first query armed fires while the reader is open).
    jest.useFakeTimers()
    const runtime = await createDuckDbRuntime({
      config: { temp_directory: "" },
      releaseMemoryAfterIdleMs: IDLE_MS,
    })
    const release = spyOn(runtime, "releaseMemory")
    try {
      await runtime.query("SELECT 1")
      await settle()
      jest.advanceTimersByTime(IDLE_MS / 2)
      const reader = await runtime.openReader("SELECT range AS n FROM range(100000)")
      await settle()
      jest.advanceTimersByTime(IDLE_MS * 5)
      expect(release).toHaveBeenCalledTimes(0)

      await reader.close()
      await settle()
      jest.advanceTimersByTime(IDLE_MS)
      expect(release).toHaveBeenCalledTimes(1)
      await release.mock.results[0]?.value
    } finally {
      await runtime.close()
    }
  })

  test("never releases when turned off, or after close", async () => {
    // Red check: remove cancelIdleRelease() from finish(); the closed runtime's timer still fires.
    jest.useFakeTimers()
    const off = await createDuckDbRuntime({
      config: { temp_directory: "" },
      releaseMemoryAfterIdleMs: false,
    })
    const closing = await createDuckDbRuntime({
      config: { temp_directory: "" },
      releaseMemoryAfterIdleMs: IDLE_MS,
    })
    const offRelease = spyOn(off, "releaseMemory")
    const closingRelease = spyOn(closing, "releaseMemory")
    try {
      await off.query("SELECT 1")
      await closing.query("SELECT 1")
      await settle()
      await closing.close()
      jest.advanceTimersByTime(IDLE_MS * 10)
      expect(offRelease).toHaveBeenCalledTimes(0)
      expect(closingRelease).toHaveBeenCalledTimes(0)
    } finally {
      await off.close()
      await closing.close()
    }
  })

  test("a release keeps the file cache setting and the memory limit", async () => {
    // Red check: drop the cache === true guard, and the cache comes back on; or read memory_limit
    // on every release, and the limit falls a tenth of a unit at a time (1.8 GiB, then 1.7 GiB).
    const runtime = await createDuckDbRuntime({
      config: { temp_directory: "", memory_limit: "1.85GiB" },
      releaseMemoryAfterIdleMs: false,
    })
    const uncached = await createDuckDbRuntime({
      config: { temp_directory: "", enable_external_file_cache: "false" },
      releaseMemoryAfterIdleMs: false,
    })
    try {
      await runtime.releaseMemory()
      const limit = await setting(runtime, "memory_limit")
      await runtime.releaseMemory()
      await runtime.releaseMemory()
      expect(await setting(runtime, "memory_limit")).toBe(limit)
      expect(await setting(runtime, "enable_external_file_cache")).toBe(true)

      await uncached.releaseMemory()
      expect(await setting(uncached, "enable_external_file_cache")).toBe(false)
    } finally {
      await runtime.close()
      await uncached.close()
    }
  })

  test("a release keeps a memory limit set after an earlier release", async () => {
    // Red check: re-apply the limit the first release read (memoryLimit ??= reported); the second
    // release puts DuckDB's default back.
    const runtime = await createDuckDbRuntime({
      config: { temp_directory: "" },
      releaseMemoryAfterIdleMs: false,
    })
    try {
      await runtime.releaseMemory()
      await runtime.run("SET memory_limit = '1.85GiB'")
      await runtime.releaseMemory()
      const limit = await setting(runtime, "memory_limit")
      expect(limit).toMatch(/^1\.[78] GiB$/)

      await runtime.releaseMemory()
      await runtime.releaseMemory()
      expect(await setting(runtime, "memory_limit")).toBe(limit)
    } finally {
      await runtime.close()
    }
  })

  test("rejects an invalid idle delay before opening the engine", () => {
    for (const releaseMemoryAfterIdleMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new DuckLakeStorage({
            catalog: { type: "duckdb", path: ":memory:" },
            duckdb: { releaseMemoryAfterIdleMs },
          })
      ).toThrow("duckdb.releaseMemoryAfterIdleMs must be a non-negative number or false")
    }
  })
})
