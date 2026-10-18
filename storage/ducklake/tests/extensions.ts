import { beforeAll } from "bun:test"
import { DuckDBInstance } from "@duckdb/node-api"

// The first INSTALL of an extension downloads it. On a cold CI runner that alone can outlast a
// test's 5 s timeout, so whichever test opened a lake first failed. Download every extension the
// suites load before any test runs; each later INSTALL finds it installed.
beforeAll(async () => {
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
}, 120_000)
