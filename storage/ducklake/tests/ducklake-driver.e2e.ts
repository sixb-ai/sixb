import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDuckDbRuntime, setupDuckLake } from "../src/internal/duckdb-runtime"
import { localDuckLakeOptions } from "./test-utils"

describe("DuckLake driver e2e", () => {
  test("loads ducklake and attaches a local catalog", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pario-ducklake-e2e-"))
    const runtime = await createDuckDbRuntime()

    try {
      await setupDuckLake(runtime, localDuckLakeOptions(rootDir))

      await runtime.run("CREATE TABLE pario_lake.main.pario__sys__driver_e2e (id INTEGER)")
      await runtime.run("INSERT INTO pario_lake.main.pario__sys__driver_e2e VALUES (1)")
      expect(true).toBe(true)
    } finally {
      await runtime.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
