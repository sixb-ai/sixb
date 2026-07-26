import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDuckDbRuntime, setupDuckLake } from "../src/internal/duckdb-runtime"
import { localDuckLakeOptions } from "./test-utils"

describe("DuckLake driver e2e", () => {
  test("preserves exact decimals across eager, exclusive, and streaming reads", async () => {
    const runtime = await createDuckDbRuntime()
    const sql = `
      SELECT
        9007199254740993.123456789::DECIMAL(38, 9) AS amount,
        NULL::DECIMAL(38, 9) AS nullable_amount
    `

    try {
      const expected = {
        amount: "9007199254740993.123456789",
        nullable_amount: null,
      }

      expect(await runtime.query(sql)).toEqual([expected])
      expect(await runtime.withExclusive((exclusive) => exclusive.query(sql))).toEqual([expected])

      const streamed = []
      for await (const row of runtime.streamRows(sql)) {
        streamed.push(row)
      }
      expect(streamed).toEqual([expected])
    } finally {
      await runtime.close()
    }
  })

  test("loads ducklake and attaches a local catalog", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sixb-ducklake-e2e-"))
    const runtime = await createDuckDbRuntime()

    try {
      await setupDuckLake(runtime, localDuckLakeOptions(rootDir))

      await runtime.run("CREATE TABLE sixb_lake.main.sixb__sys__driver_e2e (id INTEGER)")
      await runtime.run("INSERT INTO sixb_lake.main.sixb__sys__driver_e2e VALUES (1)")
      expect(true).toBe(true)
    } finally {
      await runtime.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
