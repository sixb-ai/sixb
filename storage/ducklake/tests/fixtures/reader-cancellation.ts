import { DuckDBInstance } from "@duckdb/node-api"
import { NodeDuckDbReader } from "../../src/internal/duckdb-reader"

// Run in a bounded child: removing interrupt() must fail without leaving a native query alive
// in Bun's test process. One billion transcendental operations cannot finish before the deadline.
const instance = await DuckDBInstance.create(":memory:", { threads: "1" })
const primary = await instance.connect()
try {
  for (const cancel of ["abort", "close"] as const) {
    const connection = await instance.connect()
    const controller = new AbortController()
    const reader = new NodeDuckDbReader(connection, { signal: controller.signal })
    try {
      await reader.start("SELECT sum(sin(i::DOUBLE)) FROM range(1000000000) t(i)")
      const result = reader
        .rows()
        [Symbol.asyncIterator]()
        .next()
        .catch((error: unknown) => error)
      // The heavy query is already executing on its own connection. The main one stays usable.
      await primary.run("SELECT 42")
      if (cancel === "abort") controller.abort(new Error("fixture cancelled"))
      else void reader.close().catch(() => {})
      const error = await result
      if (!(error instanceof Error) || !/fixture cancelled|closed/.test(error.message)) {
        throw new Error("The active native query did not report its cancellation")
      }
      await primary.run("SELECT 43")
    } finally {
      await reader.close()
    }
  }
} finally {
  primary.closeSync()
  instance.closeSync()
}
