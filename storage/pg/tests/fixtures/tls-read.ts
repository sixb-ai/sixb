// Child process for pg-direct-tls.e2e.ts: reads a fixed volume over TLS and reports how much the
// process grew, measured after a full collection so only retained memory counts. The first
// argument is the TLS negotiation: "direct" (sslnegotiation=direct) or "classic" (SSLRequest).
import { createPgClient } from "../../src/pg-client"

const MEBIBYTE = 1024 * 1024
const READ_MEBIBYTES = 384

const connectionString = process.env.DATABASE_URL
const negotiation = process.argv[2]
if (!connectionString || (negotiation !== "direct" && negotiation !== "classic")) {
  throw new Error("[SixbPg] Usage: DATABASE_URL=... bun tls-read.ts direct|classic")
}

const url = new URL(connectionString)
url.searchParams.set("sslmode", "require")
if (negotiation === "direct") url.searchParams.set("sslnegotiation", "direct")
const sql = createPgClient({ connectionString: url.toString(), max: 1, schemaName: "public" })

const [session] = await sql<{ ssl: boolean }[]>`
  SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()
`
Bun.gc(true)
const before = process.memoryUsage.rss()

let received = 0
await sql<{ chunk: string }[]>`
  SELECT repeat('x', ${MEBIBYTE}) AS chunk FROM generate_series(1, ${READ_MEBIBYTES})
`.cursor(8, (rows) => {
  for (const row of rows) received += row.chunk.length
})

Bun.gc(true)
const grownMebibytes = Math.round((process.memoryUsage.rss() - before) / MEBIBYTE)

console.log(
  JSON.stringify({
    ssl: session?.ssl ?? null,
    receivedMebibytes: received / MEBIBYTE,
    grownMebibytes,
  })
)
await sql.end()
