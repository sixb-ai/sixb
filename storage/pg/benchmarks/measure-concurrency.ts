import type { ObjectQuery } from "@sixb/core"
import { PostgresStorage } from "../src"

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
const max = Number(process.env.QUERY_BENCH_POOL ?? 10)
const storage = new PostgresStorage({ connectionString, schemaName, max })
const start: ObjectQuery = { kind: "start", objectTypeId: "User" }
const results = []
for (const search of [undefined, "martin"]) {
  const source: ObjectQuery = search
    ? { kind: "text", input: start, query: search, fields: ["searchText"] }
    : start
  const query: ObjectQuery = {
    kind: "expand",
    expansions: [{ linkId: "currentCity", direction: "outgoing", cardinality: "one", limit: 1 }],
    input: {
      kind: "page",
      pageSize: 40,
      input: {
        kind: "sort",
        input: source,
        fields: [
          { kind: "property", propertyId: "createdAt", direction: "desc", scalarKind: "timestamp" },
        ],
      },
    },
  }
  const pages: number[] = [],
    screens: number[] = []
  const started = performance.now()
  for (let pass = 0; pass < 3; pass++)
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const t = performance.now()
        await Promise.all([
          storage.objects.queryObjects!({
            projectId: "query-benchmark",
            query,
            includeTotal: false,
          }).then(() => pages.push(performance.now() - t)),
          ...[undefined, "1", "2", "3"].map((status) =>
            storage.objects.countObjects!({
              projectId: "query-benchmark",
              query: status
                ? {
                    kind: "filter",
                    input: source,
                    predicate: { op: "eq", propertyId: "status", value: status },
                  }
                : source,
            })
          ),
        ])
        screens.push(performance.now() - t)
      })
    )
  const result = {
    search: search ?? "all",
    pool: max,
    concurrentScreens: 5,
    screenCount: 15,
    elapsed: performance.now() - started,
    pages,
    screens,
  }
  results.push(result)
  console.log(JSON.stringify(result))
}
await Bun.write(
  `.local/query-bench/concurrency-${schemaName}-pool${max}.json`,
  JSON.stringify(results, null, 2)
)
await storage.close()
