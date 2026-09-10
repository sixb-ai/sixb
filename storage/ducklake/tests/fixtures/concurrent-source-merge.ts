import type { DatasetDefinition, DatasetRow, MergeChange } from "@sixb/core"
import { DuckLakeStorage, type DuckLakeStorageOptions } from "../../src"
import type { DuckDbRuntime } from "../../src/internal/duckdb-runtime"

const options = JSON.parse(process.argv[2] ?? "") as DuckLakeStorageOptions
const dataset = JSON.parse(process.argv[3] ?? "") as DatasetDefinition
const changes = JSON.parse(process.argv[4] ?? "") as MergeChange<DatasetRow, DatasetRow>[]
const storage = new DuckLakeStorage(options)
try {
  const session = await storage.beginMerge({ dataset })
  await session.writeChanges(changes)
  const runtime = await (
    storage as unknown as { connections: { runtime(): Promise<DuckDbRuntime> } }
  ).connections.runtime()
  const exclusive = runtime.withExclusive.bind(runtime)
  let firstCommit = true
  runtime.withExclusive = (run) =>
    exclusive((transaction) =>
      run({
        query: (sql, values) => transaction.query(sql, values),
        runStatements: (statements) => transaction.runStatements(statements),
        withAppender: (table, use) => transaction.withAppender(table, use),
        async run(sql, values) {
          if (sql === "COMMIT" && firstCommit) {
            firstCommit = false
            const released = new Promise<void>((resolve) =>
              process.once("message", () => resolve())
            )
            process.send?.({ type: "ready" })
            await released
          }
          await transaction.run(sql, values)
        },
      })
    )
  await session.commit({ retryOnConflict: true })
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await storage.close()
  process.disconnect?.()
}
