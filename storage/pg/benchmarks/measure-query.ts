import type { ObjectQuery } from "@sixb/core"
import { normalizeObjectQuery } from "../../../packages/core/src/objects/query/normalize"
import * as currentCompiler from "../src/objects/query-compiler"
import { compilePgIndexedTextCount } from "../src/objects/text-count-index"
import { createPgClient, type SqlParameter } from "../src/pg-client"

// Pass the unmodified PR compiler saved with `git show` for a same-data comparison.
const compiler: typeof currentCompiler = process.env.QUERY_BENCH_BASELINE
  ? await import(process.env.QUERY_BENCH_BASELINE)
  : currentCompiler
const schemaName = process.env.QUERY_BENCH_SCHEMA ?? "bench"
if (!/^bench(?:_[0-9]+)?$/.test(schemaName)) throw new Error("Expected a dedicated bench schema")
const sql = createPgClient({
  connectionString:
    process.env.QUERY_BENCH_URL ??
    "postgresql://postgres:local-benchmark-only@127.0.0.1:55506/sixb_query_bench",
  schemaName,
  max: 5,
  statementTimeoutMillis: 120000,
})
const label = process.argv[2] ?? "optimized"
const repetitions = Number(process.env.QUERY_BENCH_REPEATS ?? 10)
const [{ count }] =
  await sql`SELECT count(*) FROM objects WHERE project_id='query-benchmark' AND object_type_id='User'`
const n = Number(count)
const start: ObjectQuery = { kind: "start", objectTypeId: "User" }
function filtered(status?: string, search?: string): ObjectQuery {
  let query = start
  if (status)
    query = {
      kind: "filter",
      input: query,
      predicate: { op: "in", propertyId: "status", values: [status] },
    }
  if (search) query = { kind: "text", input: query, query: search, fields: ["searchText"] }
  return query
}
function page(input: ObjectQuery, sort = "recent", pageToken?: string): ObjectQuery {
  const normalized = normalizeObjectQuery({
    kind: "expand",
    expansions: [{ linkId: "currentCity", direction: "outgoing", cardinality: "one" }],
    input: {
      kind: "page",
      pageSize: 40,
      pageToken,
      input: {
        kind: "sort",
        input,
        fields:
          sort === "name"
            ? [
                {
                  kind: "property",
                  propertyId: "lastName",
                  direction: "asc",
                  scalarKind: "string",
                },
                {
                  kind: "property",
                  propertyId: "firstName",
                  direction: "asc",
                  scalarKind: "string",
                },
              ]
            : [
                {
                  kind: "property",
                  propertyId: "createdAt",
                  direction: "desc",
                  scalarKind: "timestamp",
                },
              ],
      },
    },
  })
  return normalized.kind === "expand"
    ? {
        ...normalized,
        expansions: normalized.expansions.map((expansion) => ({
          ...expansion,
          cardinality: "one",
        })),
      }
    : normalized
}
const workloads: { name: string; query: ObjectQuery; count?: boolean; total?: boolean }[] = []
for (const sort of ["recent", "name"]) {
  workloads.push({ name: sort, query: page(start, sort) })
  for (const status of ["1", "2", "3"])
    workloads.push({ name: `${sort}-status-${status}`, query: page(filtered(status), sort) })
}
for (const [name, term] of [
  ["target", "user-123456@"],
  ["absent", "nobody-unfindable"],
  ["common", "martin"],
  ["short", "ma"],
  ["multi", "jean martin"],
  ["phone", "061234"],
]) {
  workloads.push({ name: `search-${name}`, query: page(filtered(undefined, term)) })
  workloads.push({ name: `count-${name}`, query: filtered(undefined, term), count: true })
}
workloads.push({ name: "count-all", query: start, count: true })
for (const status of ["1", "2", "3"])
  workloads.push({ name: `count-status-${status}`, query: filtered(status), count: true })
const anchorId = Math.max(1, Math.floor(n / 10))
const anchor = await sql<
  currentCompiler.PgObjectQueryPageRow[]
>`SELECT object_type_id,primary_id,properties FROM objects WHERE project_id='query-benchmark' AND object_type_id='User' AND primary_id=${String(anchorId).padStart(10, "0")}`
const cursorCompiler = compiler.compilePgObjectQuery("query-benchmark", page(start), {
  includeTotal: false,
})
const token = cursorCompiler.nextPageToken(anchor, 41)
workloads.push({ name: "deep-recent", query: page(start, "recent", token) })
const selectedUser: ObjectQuery = {
  kind: "filter",
  input: start,
  predicate: { op: "eq", propertyId: "id", value: "0000123451" },
}
const city: ObjectQuery = {
  kind: "filter",
  input: { kind: "start", objectTypeId: "City" },
  predicate: { op: "in", propertyId: "id", values: ["1", "2", "3"] },
}
const residents: ObjectQuery = {
  kind: "traverse",
  input: city,
  direction: "incoming",
  sourceObjectTypeId: "User",
  linkId: "currentCity",
}
const accounts: ObjectQuery = {
  kind: "traverse",
  input: selectedUser,
  direction: "incoming",
  sourceObjectTypeId: "SupportAccount",
  linkId: "user",
}
const conversations: ObjectQuery = {
  kind: "traverse",
  input: accounts,
  direction: "outgoing",
  linkId: "conversation",
}
const subscriptions: ObjectQuery = {
  kind: "traverse",
  input: selectedUser,
  direction: "incoming",
  sourceObjectTypeId: "Subscription",
  linkId: "user",
}
workloads.push(
  {
    name: "traverse-user-city",
    query: { kind: "traverse", input: selectedUser, direction: "outgoing", linkId: "currentCity" },
  },
  { name: "traverse-cities-users", query: page(residents) },
  { name: "traverse-cities-count", query: residents, count: true },
  {
    name: "traverse-support",
    query: {
      kind: "limit",
      limit: 20,
      input: {
        kind: "sort",
        input: conversations,
        fields: [
          {
            kind: "property",
            propertyId: "lastActivityAt",
            direction: "desc",
            scalarKind: "timestamp",
          },
        ],
      },
    },
  },
  { name: "traverse-support-count", query: conversations, count: true },
  {
    name: "traverse-subscriptions",
    query: {
      kind: "page",
      pageSize: 10,
      input: {
        kind: "sort",
        input: subscriptions,
        fields: [
          {
            kind: "property",
            propertyId: "sourceCreatedAt",
            direction: "desc",
            scalarKind: "timestamp",
          },
        ],
      },
    },
  },
  {
    name: "traverse-report",
    query: {
      kind: "page",
      pageSize: 100,
      input: {
        kind: "sort",
        input: {
          kind: "filter",
          input: residents,
          predicate: {
            op: "and",
            items: [
              {
                op: "gte",
                propertyId: "firstSubscribedAt",
                value: "2015-04-01T00:00:00.000Z",
                scalarKind: "timestamp",
              },
              {
                op: "lt",
                propertyId: "firstSubscribedAt",
                value: "2025-01-01T00:00:00.000Z",
                scalarKind: "timestamp",
              },
            ],
          },
        },
        fields: [
          {
            kind: "property",
            propertyId: "firstSubscribedAt",
            direction: "asc",
            scalarKind: "timestamp",
          },
        ],
      },
    },
  }
)
workloads.push({
  ...workloads.find((w) => w.name === "traverse-report")!,
  name: "traverse-report-with-total",
  total: true,
})
const results = []
const selected = process.env.QUERY_BENCH_CASES?.split(",")
for (const workload of workloads.filter((w) => !selected || selected.includes(w.name))) {
  let compiled: currentCompiler.CompiledPgScalarQuery &
    Partial<
      Pick<currentCompiler.CompiledPgObjectQuery, "traversalProbe" | "totalSql" | "totalArgs">
    > = workload.count
    ? compiler.compilePgObjectCountQuery("query-benchmark", workload.query)
    : compiler.compilePgObjectQuery("query-benchmark", workload.query, {
        includeTotal: workload.total ?? false,
      })
  const times = []
  let answer: unknown
  for (let i = 0; i < repetitions; i++) {
    const t = performance.now()
    if (workload.count && !process.env.QUERY_BENCH_BASELINE) {
      compiled =
        (await compilePgIndexedTextCount(sql, "query-benchmark", workload.query)) ?? compiled
    }
    const probe = compiled.traversalProbe
    if (probe) {
      const candidates = await sql.unsafe(probe.sql, probe.args as SqlParameter[])
      if (candidates.length > probe.limit) {
        const correlated = compiler.compilePgObjectQuery("query-benchmark", workload.query, {
          includeTotal: workload.total ?? false,
          correlatedTraversal: true,
        })
        compiled = { ...correlated, traversalProbe: probe }
      }
    }
    const total =
      workload.total && compiled.totalSql
        ? await sql.unsafe(compiled.totalSql, (compiled.totalArgs ?? []) as SqlParameter[])
        : undefined
    const rows = await sql.unsafe(compiled.sql, compiled.args as SqlParameter[])
    times.push(performance.now() - t)
    answer = workload.count
      ? rows[0]?.count
      : total
        ? { ids: rows.map((r) => r.primary_id), total: total[0]?.total }
        : rows.map((r) => r.primary_id)
  }
  const plan = await sql.unsafe(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${compiled.sql}`,
    compiled.args as SqlParameter[]
  )
  const totalPlan =
    workload.total && compiled.totalSql
      ? await sql.unsafe(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${compiled.totalSql}`,
          (compiled.totalArgs ?? []) as SqlParameter[]
        )
      : undefined
  const sorted = [...times].sort((a, b) => a - b)
  const result = {
    name: workload.name,
    p50: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    times,
    answer,
    plan,
    totalPlan,
    sql: compiled.sql,
    args: compiled.args,
  }
  results.push(result)
  await Bun.write(
    `.local/query-bench/${label}-${n}.partial.json`,
    JSON.stringify({ n, label, repetitions, results }, null, 2)
  )
  console.log(JSON.stringify({ name: result.name, p50: result.p50, p95: result.p95 }))
}
if (!selected)
  for (const search of [undefined, "user-123456@", "martin", "ma"]) {
    const queries = [
      compiler.compilePgObjectQuery("query-benchmark", page(filtered(undefined, search)), {
        includeTotal: false,
      }),
      ...[undefined, "1", "2", "3"].map((status) =>
        compiler.compilePgObjectCountQuery("query-benchmark", filtered(status, search))
      ),
    ]
    const times = []
    for (let i = 0; i < repetitions; i++) {
      const t = performance.now()
      await Promise.all(
        queries.map(async (q, index) => {
          const indexed =
            index > 0 && !process.env.QUERY_BENCH_BASELINE
              ? await compilePgIndexedTextCount(
                  sql,
                  "query-benchmark",
                  filtered([undefined, "1", "2", "3"][index - 1], search)
                )
              : undefined
          const selected = indexed ?? q
          return sql.unsafe(selected.sql, selected.args as SqlParameter[])
        })
      )
      times.push(performance.now() - t)
    }
    const sorted = [...times].sort((a, b) => a - b)
    const result = {
      name: `screen-${search ?? "all"}`,
      p50: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
      times,
    }
    results.push(result)
    await Bun.write(
      `.local/query-bench/${label}-${n}.partial.json`,
      JSON.stringify({ n, label, repetitions, results }, null, 2)
    )
    console.log(JSON.stringify(result))
  }
const settings =
  await sql`SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','effective_cache_size','max_parallel_workers_per_gather','server_version','jit')`
const sizes =
  await sql`SELECT relname,pg_relation_size(oid) AS bytes FROM pg_class WHERE relnamespace=${schemaName}::regnamespace AND (relname IN ('objects','links') OR relname LIKE 'sixb_query_%' OR relname LIKE 'idx_objects_%' OR relname LIKE 'sixb_text_count_%') ORDER BY relname`
await Bun.write(
  `.local/query-bench/${label}-${n}.json`,
  JSON.stringify({ n, label, repetitions, settings, sizes, results }, null, 2)
)
await sql.end()
