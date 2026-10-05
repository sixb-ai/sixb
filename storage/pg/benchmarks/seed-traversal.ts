import { createPgClient } from "../src/pg-client"

const schemaName = process.env.QUERY_BENCH_SCHEMA ?? "bench"
if (!/^bench(?:_[0-9]+)?$/.test(schemaName)) throw new Error("Expected a dedicated bench schema")
const connectionString =
  process.env.QUERY_BENCH_URL ??
  "postgresql://postgres:local-benchmark-only@127.0.0.1:55506/sixb_query_bench"
const target = new URL(connectionString)
if (
  !["127.0.0.1", "localhost", "host.docker.internal"].includes(target.hostname) ||
  target.port !== "55506" ||
  target.pathname !== "/sixb_query_bench"
)
  throw new Error("Use the dedicated local benchmark database")
const sql = createPgClient({ connectionString, schemaName, max: 1 })
const [{ count }] =
  await sql`SELECT count(*) FROM objects WHERE project_id='query-benchmark' AND object_type_id='User'`
const users = Number(count),
  accounts = Math.floor(users / 10),
  conversations = Math.ceil(accounts / 4)
for (const [type, n] of [
  ["SupportAccount", accounts],
  ["SupportConversation", conversations],
  ["Subscription", accounts * 2],
] as const) {
  const [{ count: existing }] =
    await sql`SELECT count(*) FROM objects WHERE project_id='query-benchmark' AND object_type_id=${type}`
  for (let i = Number(existing); i < n; i += 50000) {
    await sql`INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id) SELECT 'query-benchmark',${type},g::text,jsonb_build_object('id',g::text,'subject','Synthetic support '||g,'status','resolved','lastActivityAt',to_char('2020-01-01'::timestamp+g*interval '1 minute','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sourceCreatedAt',to_char('2020-01-01'::timestamp+g*interval '1 minute','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),now(),now(),1,'seed' FROM generate_series(${i + 1}::int,${Math.min(n, i + 50000)}::int) g`
    console.log(type, Math.min(n, i + 50000))
  }
}
for (let i = 0; i < accounts; i += 50000) {
  await sql`INSERT INTO links SELECT 'query-benchmark','SupportAccount',g::text,'user','User',lpad((1+(g%${Math.max(1, accounts / 2)}::int)*10)::text,10,'0'),NULL,now(),now(),'seed' FROM generate_series(${i + 1}::int,${Math.min(accounts, i + 50000)}::int) g ON CONFLICT DO NOTHING`
  await sql`INSERT INTO links SELECT 'query-benchmark','SupportAccount',g::text,'conversation','SupportConversation',ceil(g/4.0)::int::text,NULL,now(),now(),'seed' FROM generate_series(${i + 1}::int,${Math.min(accounts, i + 50000)}::int) g ON CONFLICT DO NOTHING`
}
for (let i = 0; i < accounts * 2; i += 50000) {
  await sql`INSERT INTO links SELECT 'query-benchmark','Subscription',g::text,'user','User',lpad((1+(g%${Math.max(1, accounts / 2)}::int)*10)::text,10,'0'),NULL,now(),now(),'seed' FROM generate_series(${i + 1}::int,${Math.min(accounts * 2, i + 50000)}::int) g ON CONFLICT DO NOTHING`
}
await sql.unsafe("VACUUM (ANALYZE) objects")
await sql.unsafe("VACUUM (ANALYZE) links")
await sql.end()
