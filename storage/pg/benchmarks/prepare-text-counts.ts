import { PostgresStorage } from "../src"

const connectionString =
  process.env.QUERY_BENCH_URL ??
  "postgresql://postgres:local-benchmark-only@127.0.0.1:55506/sixb_query_bench"
const target = new URL(connectionString)
const schemaName = process.env.QUERY_BENCH_SCHEMA ?? "bench"
if (
  !["127.0.0.1", "localhost", "host.docker.internal"].includes(target.hostname) ||
  target.port !== "55506" ||
  target.pathname !== "/sixb_query_bench" ||
  !/^bench(?:_[0-9]+)?$/.test(schemaName)
)
  throw new Error("Use the dedicated local query benchmark database")
const storage = new PostgresStorage({ connectionString, schemaName })
console.time("prepare text counts")
console.log(
  await storage.prepareObjectTextCounts([
    {
      projectId: "query-benchmark",
      objectTypeId: "User",
      propertyId: "searchText",
      filters: ["status"],
    },
  ])
)
console.timeEnd("prepare text counts")
await storage.close()
