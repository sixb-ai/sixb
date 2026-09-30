// Child process for pg-connection-loss.e2e.ts: loses the connection under an open transaction and
// reports what happened. It runs apart from the test runner because the failure it guards against
// is an uncaught exception that kills the whole process.
import { createPgClient } from "../../src/pg-client"
import { runPgTransaction } from "../../src/transactions"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("[SixbPg] DATABASE_URL is required.")
}

process.on("uncaughtException", (error) => {
  console.log(JSON.stringify({ uncaught: String(error) }))
  process.exit(1)
})

// One connection: a dead connection handed back to the pool would be the only one left.
const sql = createPgClient({ connectionString, max: 1, schemaName: "public" })
const admin = createPgClient({ connectionString, max: 1, schemaName: "public" })

let rejection: unknown
try {
  await runPgTransaction(
    sql,
    async (tx) => {
      const [session] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      if (!session) throw new Error("expected a backend pid")
      await Promise.all([
        tx`SELECT pg_sleep(10)`,
        admin`SELECT pg_sleep(0.2), pg_terminate_backend(${session.pid})`,
      ])
    },
    { isolation: "serializable" }
  )
} catch (error) {
  rejection = error
}

// Deferred writes on a closed socket fire on the next turns of the event loop; give them room.
await new Promise((resolve) => setTimeout(resolve, 200))

// postgres.js 3.4.9 keeps the killed session's error and replays it onto the first query sent on
// the reconnected slot (porsager/postgres#1241 fixes only the startup variant). That query fails
// once with the stale FATAL error; the one after it must succeed.
const ping = () =>
  sql<{ ok: number }[]>`SELECT 1 AS ok`.then(
    ([row]) => (row?.ok === 1 ? "ok" : "unexpected"),
    (error: unknown) => (error as { readonly code?: unknown }).code ?? String(error)
  )
const firstQuery = await ping()
const secondQuery = await ping()

console.log(
  JSON.stringify({
    rejection: (rejection as { readonly code?: unknown } | undefined)?.code ?? null,
    firstQuery,
    secondQuery,
  })
)
await Promise.all([sql.end(), admin.end()])
