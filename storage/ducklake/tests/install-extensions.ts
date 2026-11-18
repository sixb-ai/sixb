import { DuckDBInstance } from "@duckdb/node-api"

/**
 * The first INSTALL of an extension downloads it. On a cold CI runner that alone can outlast a
 * test's 5 s timeout, so whichever test opened a lake first failed. Download every extension the
 * suites load before any test runs; each later INSTALL finds it installed.
 *
 * `test:e2e` runs this once on its own before `bun test --parallel` starts its workers, so they
 * never download the same file at once. The `extensions.ts` preload runs it again for a direct
 * `bun test`, where it finds everything installed.
 */
export async function installExtensions(): Promise<void> {
  const instance = await DuckDBInstance.create(":memory:")
  const connection = await instance.connect()
  try {
    for (const extension of ["ducklake", "sqlite", "postgres", "httpfs"]) {
      await connection.run(`INSTALL ${extension}`)
    }
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

if (import.meta.main) {
  // The preload's 120 s hook timeout bounded a stalled download; on its own, this needs its own.
  const timer = setTimeout(() => {
    console.error("[DuckLake] Installing DuckDB extensions took longer than 120 s.")
    process.exit(1)
  }, 120_000)
  await installExtensions()
  clearTimeout(timer)
}
