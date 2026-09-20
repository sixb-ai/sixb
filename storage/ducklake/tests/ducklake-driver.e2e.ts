import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDuckDbRuntime, setupDuckLake } from "../src/internal/duckdb-runtime"
import { localDuckLakeOptions } from "./test-utils"

describe("DuckLake driver e2e", () => {
  test("interrupts native execution without interrupting the main connection", async () => {
    const fixture = new URL("./fixtures/reader-cancellation.ts", import.meta.url)
    const child = Bun.spawn([process.execPath, fixture.pathname], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = setTimeout(() => child.kill("SIGKILL"), 4_000)
    try {
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, output, error }).toEqual({ code: 0, output: "", error: "" })
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null) child.kill("SIGKILL")
    }
  })

  test("isolates spill files between runtimes and only cleans its own directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sixb-spill-e2e-"))
    await writeFile(join(root, "keep.txt"), "caller-owned")
    const options = { config: { temp_directory: root, memory_limit: "64MB", threads: "1" } }
    const first = await createDuckDbRuntime(options)
    const second = await createDuckDbRuntime(options)
    try {
      const setting = "SELECT current_setting('temp_directory') AS directory"
      const [a] = await first.query(setting)
      const [b] = await second.query(setting)
      // Red check: pass options.config directly to DuckDBInstance.create(). Both engines then
      // use the same filenames; asserting isolation first avoids deliberately corrupting data.
      expect(a?.directory).not.toBe(b?.directory)
      expect(String(a?.directory).startsWith(root)).toBe(true)
      expect(String(b?.directory).startsWith(root)).toBe(true)
      await first.run(
        "CREATE TEMP TABLE spill AS SELECT i, md5(i::VARCHAR) AS value FROM range(1000000) t(i)"
      )
      await second.run(
        "CREATE TEMP TABLE spill AS SELECT i, md5((i+1)::VARCHAR) AS value FROM range(1000000) t(i)"
      )
      expect(
        await first.query("SELECT count(*) AS invalid FROM spill WHERE value != md5(i::VARCHAR)")
      ).toEqual([{ invalid: 0n }])
      await first.close()
      expect(
        await second.query(
          "SELECT count(*) AS invalid FROM spill WHERE value != md5((i+1)::VARCHAR)"
        )
      ).toEqual([{ invalid: 0n }])
    } finally {
      await first.close()
      await second.close()
      expect(await readdir(root)).toEqual(["keep.txt"])
      await rm(root, { recursive: true, force: true })
    }
  })

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
      for await (const row of (await runtime.openReader(sql)).rows()) {
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
