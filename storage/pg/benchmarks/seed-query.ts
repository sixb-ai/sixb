import { migrateStorage } from "@sixb/core"
import { PostgresStorage } from "../src/index"
import { createPgClient } from "../src/pg-client"

// Refuse application databases: this fixture writes synthetic objects directly.
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
  throw new Error("Use the dedicated local query benchmark database on port 55506")
const storage = new PostgresStorage({ connectionString, schemaName, max: 5 })
await migrateStorage(storage)
const sql = createPgClient({
  connectionString,
  schemaName,
  max: 5,
  statementTimeoutMillis: 120000,
})
const n = Number(process.argv[2] ?? 300000)
if (!Number.isSafeInteger(n) || n < 1 || n > 5000000) throw new Error("Expected 1..5000000 rows")
const [{ count }] = await sql`SELECT count(*) FROM objects WHERE object_type_id='User'`
if (Number(count) < n) {
  console.log(`Seeding ${Number(count)} -> ${n}`)
  for (let i = Number(count); i < n; i += 50000) {
    await sql`INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id) SELECT 'query-benchmark','User',lpad(g::text,10,'0'),jsonb_build_object('id',lpad(g::text,10,'0'),'firstName',(ARRAY['Camille','Jean','Marie','Thomas','Lea','Paul','Sophie','Antoine'])[1+g%8], 'lastName',(ARRAY['Martin','Bernard','Dubois','Petit','Robert','Richard','Durand','Moreau','Lefebvre','Garcia','Roux'])[1+g%11], 'email','user-'||g||'@example.test','phone','06'||lpad(g::text,8,'0'),'billingCustomerId','cus_'||md5(g::text),'status',CASE WHEN g%100<80 THEN '1' WHEN g%100<95 THEN '2' ELSE '3' END,'createdAt',to_char('2015-01-01'::timestamp+g*interval '1 minute','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'firstSubscribedAt',to_char('2015-02-01'::timestamp+g*interval '1 minute','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'verificationStatus',(g%4)::text,'birthDate','1990-01-01','newsletterSubscribed',g%2=0,'searchText',lower((ARRAY['Camille','Jean','Marie','Thomas','Lea','Paul','Sophie','Antoine'])[1+g%8]||' '||(ARRAY['Martin','Bernard','Dubois','Petit','Robert','Richard','Durand','Moreau','Lefebvre','Garcia','Roux'])[1+g%11]||' user-'||g||'@example.test 06'||lpad(g::text,8,'0')||' cus_'||md5(g::text))),'2026-10-01'::timestamptz,'2026-10-01'::timestamptz,1,'seed' FROM generate_series(${i + 1}::int,${Math.min(n, i + 50000)}::int) g`
    console.log(`Seeded ${Math.min(n, i + 50000)}`)
  }
  await sql.unsafe("VACUUM (ANALYZE) objects")
}

await sql`INSERT INTO objects (project_id,object_type_id,primary_id,properties,created_at,updated_at,version,last_commit_id) SELECT 'query-benchmark', 'City', n::text, jsonb_build_object('id',n::text,'name','City '||n), now(),now(),1,'seed' FROM generate_series(1,100) n ON CONFLICT DO NOTHING`
const [{ last }] =
  await sql`SELECT max(source_id) AS last FROM links WHERE project_id='query-benchmark' AND source_type_id='User' AND link_id='currentCity'`
for (let i = Number(last ?? 0); i < n; i += 50000) {
  await sql`INSERT INTO links SELECT 'query-benchmark','User',lpad(g::text,10,'0'),'currentCity','City',(1+g%100)::text,NULL,now(),now(),'seed' FROM generate_series(${i + 1}::int,${Math.min(n, i + 50000)}::int) g ON CONFLICT DO NOTHING`
  console.log(`Linked ${Math.min(n, i + 50000)}`)
}
await sql.unsafe("VACUUM (ANALYZE) links")
await sql.end()
await storage.close()
