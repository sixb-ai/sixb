import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { PostgresStorage } from "../src"
import {
  benchmarkOntology,
  City,
  Subscription,
  SupportAccount,
  SupportConversation,
  User,
} from "./ontology"

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
const repeats = Number(process.env.QUERY_BENCH_REPEATS ?? 10)
const max = Number(process.env.QUERY_BENCH_POOL ?? 2)
const storage = new PostgresStorage({ connectionString, schemaName, max })
const host = new SixbHost({
  id: "query-benchmark",
  ontology: benchmarkOntology.listObjectTypes(),
  storage,
  broker: new InMemoryBroker(),
  queues: new InMemoryQueues(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
})
const sixb = createTestSixb(host)
const base = sixb.objects(User).query()
const recent = base
  .orderBy(User.p.createdAt, "desc")
  .expand(User.l.currentCity)
  .page({ pageSize: 40 })
const name = base
  .orderBy(User.p.lastName)
  .orderBy(User.p.firstName)
  .expand(User.l.currentCity)
  .page({ pageSize: 40 })
const frequent = base.search("martin", { fields: [User.p.searchText] })
const rare = base.search("user-123456@", { fields: [User.p.searchText] })
const email = base.search("user-123451@example.test", { fields: [User.p.searchText] })
const facets = [{ property: User.p.status, limit: 100 }]
const city = sixb
  .objects(City)
  .query()
  .where((c) => c.p.id.in(["1", "2", "3"]))
const residents = city.traverse(User.l.currentCity, { direction: "incoming" })
const selected = base.where((user) => user.p.id.eq("0000123451"))
const conversations = selected
  .traverse(SupportAccount.l.user, { direction: "incoming" })
  .traverse(SupportAccount.l.conversation)
const subscriptions = selected.traverse(Subscription.l.user, { direction: "incoming" })
const report = residents
  .where((u) => u.p.firstSubscribedAt.gte("2015-04-01T00:00:00.000Z"))
  .where((u) => u.p.firstSubscribedAt.lt("2025-01-01T00:00:00.000Z"))
  .orderBy(User.p.firstSubscribedAt)
  .page({ pageSize: 100 })
const { createPgClient } = await import("../src/pg-client")
const { compilePgObjectQuery } = await import("../src/objects/query-compiler")
const probe = createPgClient({ connectionString, schemaName, max: 1 })
const [anchor] = await probe<
  { object_type_id: string; primary_id: string; properties: Record<string, unknown> }[]
>`SELECT object_type_id,primary_id,properties FROM objects WHERE project_id='query-benchmark' AND object_type_id='User' AND primary_id=${schemaName === "bench" ? "0000500000" : schemaName === "bench_1000000" ? "0000100000" : "0000030000"}`
const token = compilePgObjectQuery(
  "query-benchmark",
  {
    kind: "page",
    pageSize: 40,
    input: {
      kind: "sort",
      input: { kind: "start", objectTypeId: "User" },
      fields: [
        { kind: "property", propertyId: "createdAt", direction: "desc", scalarKind: "timestamp" },
      ],
    },
  },
  { includeTotal: false }
).nextPageToken([anchor!], 41)
await probe.end()
const cases: { name: string; run: () => Promise<unknown> }[] = [
  { name: "recent", run: () => recent.list({ includeTotal: false }) },
  {
    name: "deep-recent",
    run: () =>
      base
        .orderBy(User.p.createdAt, "desc")
        .expand(User.l.currentCity)
        .page({ pageSize: 40, pageToken: token })
        .list({ includeTotal: false }),
  },
  { name: "name", run: () => name.list({ includeTotal: false }) },
  {
    name: "rare-search",
    run: () =>
      rare.orderBy(User.p.createdAt, "desc").page({ pageSize: 40 }).list({ includeTotal: false }),
  },
  {
    name: "full-email-search",
    run: () =>
      email.orderBy(User.p.createdAt, "desc").page({ pageSize: 40 }).list({ includeTotal: false }),
  },
  ...["1", "2", "3"].flatMap((status) => [
    {
      name: `recent-status-${status}`,
      run: () =>
        base
          .where((u) => u.p.status.eq(status))
          .orderBy(User.p.createdAt, "desc")
          .expand(User.l.currentCity)
          .page({ pageSize: 40 })
          .list({ includeTotal: false }),
    },
    {
      name: `name-status-${status}`,
      run: () =>
        base
          .where((u) => u.p.status.eq(status))
          .orderBy(User.p.lastName)
          .orderBy(User.p.firstName)
          .expand(User.l.currentCity)
          .page({ pageSize: 40 })
          .list({ includeTotal: false }),
    },
  ]),
  { name: "summary-all", run: () => base.facets(facets) },
  { name: "summary-frequent", run: () => frequent.facets(facets) },
  { name: "summary-rare", run: () => rare.facets(facets) },
  {
    name: "city-page",
    run: () =>
      residents
        .orderBy(User.p.createdAt, "desc")
        .page({ pageSize: 40 })
        .list({ includeTotal: false }),
  },
  { name: "city-count", run: () => residents.count() },
  {
    name: "support-two-hop",
    run: () =>
      conversations
        .orderBy(SupportConversation.p.lastActivityAt, "desc")
        .limit(20)
        .list({ includeTotal: false }),
  },
  { name: "report-page", run: () => report.list({ includeTotal: false }) },
  { name: "report-total", run: () => report.list({ includeTotal: true }) },
  {
    name: "subscriptions",
    run: () =>
      subscriptions
        .orderBy(Subscription.p.sourceCreatedAt, "desc")
        .limit(20)
        .list({ includeTotal: false }),
  },
]
const results: unknown[] = []
try {
  for (const item of cases) {
    const samples: number[] = []
    let answer: unknown
    for (let pass = 0; pass < repeats; pass++) {
      const started = performance.now()
      answer = await item.run()
      samples.push(performance.now() - started)
    }
    const sorted = [...samples].sort((a, b) => a - b)
    const result = {
      name: item.name,
      samples,
      first: samples[0],
      p50: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      answer,
    }
    results.push(result)
    console.log(JSON.stringify({ ...result, answer: undefined }))
  }
  for (const search of [undefined, "martin"]) {
    const source = search ? base.search(search, { fields: [User.p.searchText] }) : base
    const pages: number[] = []
    const screens: number[] = []
    for (let burst = 0; burst < 3; burst++)
      await Promise.all(
        Array.from({ length: 5 }, async () => {
          const started = performance.now()
          await Promise.all([
            source
              .orderBy(User.p.createdAt, "desc")
              .expand(User.l.currentCity)
              .page({ pageSize: 40 })
              .list({ includeTotal: false })
              .then(() => pages.push(performance.now() - started)),
            source.facets([{ property: User.p.status, limit: 99 }]),
          ])
          screens.push(performance.now() - started)
        })
      )
    const result = { name: `five-screens-${search ?? "all"}`, pages, screens }
    results.push(result)
    console.log(JSON.stringify(result))
  }
  const distinct = await Promise.all(
    ["martin", "jean", "marie", "paul", "ma"].map(async (term) => {
      const source = base.search(term, { fields: [User.p.searchText] })
      const started = performance.now()
      let pageMs = 0
      await Promise.all([
        source
          .orderBy(User.p.createdAt, "desc")
          .expand(User.l.currentCity)
          .page({ pageSize: 40 })
          .list({ includeTotal: false })
          .then(() => {
            pageMs = performance.now() - started
          }),
        source.facets([{ property: User.p.status, limit: 98 }]),
      ])
      return { term, pageMs, screenMs: performance.now() - started }
    })
  )
  results.push({ name: "five-distinct-searches", results: distinct })
  console.log(JSON.stringify({ name: "five-distinct-searches", results: distinct }))
  await Bun.write(
    `.local/query-bench/framework-${schemaName}-pool${max}.json`,
    JSON.stringify(results, null, 2)
  )
} finally {
  await host.closeBroker()
  await host.closeBlobs()
  await host.closeLogger()
  await storage.close()
}
