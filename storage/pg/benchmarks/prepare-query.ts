import { migrateStorage, prepareObjectQueries } from "@sixb/core"
import { PostgresStorage } from "../src"
import { benchmarkOntology } from "./ontology"

const connectionString =
  process.env.QUERY_BENCH_URL ??
  "postgresql://postgres:local-benchmark-only@127.0.0.1:55506/sixb_query_bench"
const url = new URL(connectionString)
const schemaName = process.env.QUERY_BENCH_SCHEMA ?? "bench"
if (
  !["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname) ||
  url.port !== "55506" ||
  url.pathname !== "/sixb_query_bench" ||
  !/^bench(?:_[0-9]+)?$/.test(schemaName)
)
  throw new Error("Expected the dedicated local benchmark database")
const storage = new PostgresStorage({ connectionString, schemaName, max: 2 })
try {
  await migrateStorage(storage)
  console.time("prepare ontology queries")
  console.log(
    await prepareObjectQueries({
      projectId: "query-benchmark",
      ontology: benchmarkOntology,
      storage,
    })
  )
  console.timeEnd("prepare ontology queries")
} finally {
  await storage.close()
}
