import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { PostgresStorage } from "../src"
import { hostedBranchRoleName, SCRAM_ITERATIONS } from "../src/hosted-branches"
import { quoteIdent } from "../src/migrations"
import { createPgClient } from "../src/pg-client"
import { authLockKey, lockAdvisoryKeys, runPgTransaction } from "../src/transactions"
import { createTestStorage, disposeTestStorage } from "./helpers"

// A hosted branch's database and role on production's instance, checked against PostgreSQL
// itself: each property below fails if the code that gives it is taken out. Production runs as a
// user that is no superuser, as on a managed instance, unless a test needs a superuser's right.

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
})

async function production(options: { readonly superuser?: boolean } = {}) {
  const test = await createTestStorage()
  cleanups.push(() => disposeTestStorage(test.storage))
  const admin = new Bun.SQL(test.connectionString)
  cleanups.push(() => admin.close())

  // Hosted branches refuse a production database every role may connect to.
  const database = quoteIdent(new URL(test.connectionString).pathname.slice(1))
  await admin.unsafe(`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`)
  if (options.superuser) return { ...test, admin }

  const storage = await productionAs(
    admin,
    test.connectionString,
    test.schemaName,
    "CREATEROLE CREATEDB"
  )
  return { ...test, storage, admin }
}

async function hosted(storage: PostgresStorage, name: string, limits = {}) {
  await storage.createHostedBranch(name, limits)
  cleanups.push(() => storage.dropHostedBranch(name))
}

/** A client of the branch's own, logged in as its role, as its runtime is. */
async function asRole(storage: PostgresStorage, name: string) {
  const login = await storage.openHostedBranch(name)
  const sql = new Bun.SQL(login.url, { max: 1 })
  cleanups.push(() => sql.close())
  return { sql, login }
}

/** The branch's runtime, migrating its own database as its role. */
async function runtime(storage: PostgresStorage, name: string, max = 2) {
  const login = await storage.openHostedBranch(name)
  const branch = new PostgresStorage({
    connectionString: login.url,
    schemaName: login.schemaName,
    max,
  })
  cleanups.push(() => branch.close())
  for (const migrator of branch.migrators) await migrator.migrate()
  return branch
}

/** The superuser's client on another database of the instance, such as a branch's. */
function adminOn(connectionString: string, database: string) {
  const url = new URL(connectionString)
  url.pathname = `/${database}`
  const sql = new Bun.SQL(url.toString(), { max: 1 })
  cleanups.push(() => sql.close())
  return sql
}

async function role(admin: Bun.SQL, name: string) {
  const [row] = (await admin`
    SELECT rolcanlogin AS login, rolvaliduntil AS "validUntil" FROM pg_roles WHERE rolname = ${name}
  `) as { login: boolean; validUntil: Date | null }[]
  return row
}

async function rejection(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => "resolved",
    (error: unknown) => String(error)
  )
}

describe("a hosted branch's database", () => {
  // Guard check: create the database without `OWNER` in `PgHostedBranches.create`: it then
  // belongs to production, and so would anything production ran in it.
  test("belongs to the branch's role, empty until the branch's runtime migrates it as the role", async () => {
    const { storage, admin, connectionString, schemaName } = await production()
    await hosted(storage, "feature-a")
    const name = await storage.hostedBranchRole("feature-a")
    const inBranch = adminOn(connectionString, name)

    const [database] = (await admin`
      SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ${name}
    `) as { owner: string }[]
    expect(database?.owner).toBe(name)
    const relations = () => inBranch<{ owner: string }[]>`
      SELECT pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schemaName}
    `
    expect(await relations()).toHaveLength(0)

    await runtime(storage, "feature-a")
    const owners = new Set((await relations()).map((row) => row.owner))
    expect([...owners]).toEqual([name])
  })

  // Text indexes and vectors take extensions a branch's role may not create.
  // Guard check: skip `createExtensions` in `PgHostedBranches.create`.
  test("has production's extensions before its role first logs in", async () => {
    // pgvector is no trusted extension: only a superuser creates it.
    const { storage, admin, connectionString } = await production({ superuser: true })
    await admin`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`
    await admin`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public`
    await hosted(storage, "feature-a")

    const inBranch = adminOn(connectionString, await storage.hostedBranchRole("feature-a"))
    const extensions = await inBranch<{ name: string }[]>`
      SELECT extname AS name FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname
    `
    expect(extensions.map((row) => row.name)).toEqual(["pg_trgm", "vector"])
  })

  // Guard check: put the plain password in `PgHostedBranches.open`'s DDL: the server then hashes
  // it with its own 4096 iterations.
  test("logs its role in with a verifier production computed, never a plain password in DDL", async () => {
    const { storage, admin } = await production()
    const name = await storage.hostedBranchRole("feature-a")
    const stored = async () =>
      (
        (await admin`SELECT rolpassword FROM pg_authid WHERE rolname = ${name}`) as {
          rolpassword: string | null
        }[]
      )[0]?.rolpassword

    await hosted(storage, "feature-a")
    expect(await stored()).toBeNull()

    const { sql } = await asRole(storage, "feature-a")
    expect(await sql`SELECT current_user AS name, current_database() AS database`).toEqual([
      { name, database: name },
    ])
    const first = await stored()
    await storage.openHostedBranch("feature-a")

    expect(first).toStartWith(`SCRAM-SHA-256$${SCRAM_ITERATIONS}:`)
    expect(await stored()).toStartWith(`SCRAM-SHA-256$${SCRAM_ITERATIONS}:`)
    expect(await stored()).not.toBe(first)
  })

  // A branch's login lives in its runtime's environment, where the branch's code reads it.
  // Guard checks: drop `NOLOGIN` from `close`, and the kept login still works once the branch
  // stopped; drop `endSessions` from `open`, and an earlier runtime's session outlives the next
  // start; drop `VALID UNTIL` from `open`, and the login never runs out.
  test("logs in only between an open and a close, for a while, and only its latest runtime", async () => {
    const { storage, admin } = await production()
    await hosted(storage, "feature-a")
    const name = await storage.hostedBranchRole("feature-a")
    expect((await role(admin, name))?.login).toBe(false)

    const { sql: earlier } = await asRole(storage, "feature-a")
    await earlier`SELECT 1`
    const opened = await role(admin, name)
    expect(opened?.login).toBe(true)
    const lease = (opened?.validUntil?.getTime() ?? 0) - Date.now()
    expect(lease).toBeGreaterThan(10 * 60_000)
    expect(lease).toBeLessThan(20 * 60_000)

    const { sql: later, login } = await asRole(storage, "feature-a")
    expect(await rejection(earlier`SELECT 1`)).not.toBe("resolved")
    expect(await later`SELECT 1 AS ok`).toEqual([{ ok: 1 }])

    await storage.closeHostedBranch("feature-a")
    expect((await role(admin, name))?.login).toBe(false)
    expect(await rejection(later`SELECT 1`)).not.toBe("resolved")
    const kept = new Bun.SQL(login.url, { max: 1 })
    cleanups.push(() => kept.close())
    expect(await rejection(kept`SELECT 1`)).toContain("not permitted to log in")
  })

  // Guard check: drop the renewal from `slowCheck`: the login then runs out under a branch its
  // worker still holds.
  test("renews the login of a branch its worker holds, and of no other", async () => {
    const { storage, admin } = await production()
    await hosted(storage, "feature-a")
    await hosted(storage, "feature-b")
    await storage.openHostedBranch("feature-a")
    const a = await storage.hostedBranchRole("feature-a")
    const b = await storage.hostedBranchRole("feature-b")
    await admin.unsafe(`ALTER ROLE ${quoteIdent(a)} VALID UNTIL '2000-01-01'`)

    await storage.enforceHostedBranchLimits("feature-a")
    await storage.enforceHostedBranchLimits("feature-b")

    expect((await role(admin, a))?.validUntil?.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000)
    expect(await role(admin, b)).toEqual({ login: false, validUntil: null })
  })

  // Guard check: give the role CREATEROLE in `create`: it then lifts each limit below.
  test("cannot lift its role's own limits", async () => {
    const { storage } = await production()
    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")

    expect(await rejection(sql`ALTER ROLE CURRENT_USER CONNECTION LIMIT 100`)).toContain(
      "permission denied"
    )
    expect(await rejection(sql`ALTER ROLE CURRENT_USER VALID UNTIL 'infinity'`)).toContain(
      "permission denied"
    )
    expect(await rejection(sql`ALTER ROLE CURRENT_USER SET temp_file_limit = -1`)).toContain(
      "permission denied"
    )
    // It may lower the defaults of its time limits: production enforces them from outside.
    expect(
      await sql`ALTER ROLE CURRENT_USER SET idle_in_transaction_session_timeout = 0`
    ).toBeDefined()
  })

  // Guard check: drop `CONNECTION LIMIT` from the role's DDL.
  test("holds its role to its connection limit", async () => {
    const { storage } = await production()
    await hosted(storage, "feature-a", { connectionLimit: 2 })
    const login = await storage.openHostedBranch("feature-a")

    const clients = [0, 1, 2].map(() => new Bun.SQL(login.url, { max: 1 }))
    for (const client of clients) cleanups.push(() => client.close())

    await clients[0]!`SELECT 1`
    await clients[1]!`SELECT 1`
    expect(await rejection(clients[2]!`SELECT 1`)).toContain("too many connections for role")
  })

  // Guard check: return without signalling in `PgHostedBranches.enforce`: the statement and the
  // transaction run on.
  test("stops its role's statements and transactions past their limits, whatever it SET", async () => {
    const { storage, admin } = await production()
    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")
    const name = await storage.hostedBranchRole("feature-a")

    const statement = await sql.reserve()
    await statement`SET statement_timeout = 0`
    const sleeping = rejection(statement`SELECT pg_sleep(5)`)
    await until(async () => {
      const rows = await admin`
        SELECT 1 FROM pg_stat_activity
        WHERE usename = ${name} AND state = 'active' AND now() - query_start > interval '150 ms'
      `
      return rows.length > 0
    })

    expect(
      await storage.enforceHostedBranchLimits("feature-a", { statementTimeoutMillis: 100 })
    ).toEqual({ stopped: 1, closed: null })
    expect(await sleeping).toContain("canceling statement")
    statement.release()

    const transaction = new Bun.SQL((await storage.openHostedBranch("feature-a")).url, { max: 1 })
    cleanups.push(() => transaction.close())
    const held = await transaction.reserve()
    await held`BEGIN`
    await held`SELECT 1`
    await until(async () => {
      const rows = await admin`
        SELECT 1 FROM pg_stat_activity
        WHERE usename = ${name} AND now() - xact_start > interval '150 ms'
      `
      return rows.length > 0
    })

    await storage.enforceHostedBranchLimits("feature-a", { transactionTimeoutMillis: 100 })
    expect(await rejection(held`SELECT 1`)).not.toBe("resolved")
  })

  // An open transaction holds back vacuum on production's whole instance.
  // Guard check: drop the idle-in-transaction clause from `ended` in `enforce`.
  test("ends a session of its role idle in a transaction past the limit, whatever it SET", async () => {
    const { storage, admin } = await production()
    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")
    const name = await storage.hostedBranchRole("feature-a")

    const session = await sql.reserve()
    await session`SET idle_in_transaction_session_timeout = 0`
    await session`BEGIN`
    await session`SELECT 1`
    await until(async () => {
      const rows = await admin`
        SELECT 1 FROM pg_stat_activity
        WHERE usename = ${name} AND state = 'idle in transaction'
          AND now() - state_change > interval '150 ms'
      `
      return rows.length > 0
    })

    expect(
      await storage.enforceHostedBranchLimits("feature-a", { idleInTransactionMillis: 100 })
    ).toEqual({ stopped: 1, closed: null })
    expect(await rejection(session`SELECT 1`)).not.toBe("resolved")
  })

  // Advisory locks are per database: a branch holding production's own keys, an AI limit's or a
  // session's, holds them in its own database, where production never takes them.
  // Guard check: point the login `open` gives at production's database instead of the branch's:
  // production then waits on the branch's key.
  test("takes its advisory locks in its own database, apart from production's", async () => {
    const { storage, connectionString, schemaName } = await production()
    await hosted(storage, "feature-a")
    const login = await storage.openHostedBranch("feature-a")
    const prod = createPgClient({ connectionString, schemaName, max: 1 })
    const branch = createPgClient({
      connectionString: login.url,
      schemaName: login.schemaName,
      max: 1,
    })
    cleanups.push(
      () => prod.end(),
      () => branch.end()
    )
    const key = authLockKey("session", "shop", "usr_ada")

    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked: () => void = () => {}
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    const branchHolds = runPgTransaction(branch, async (tx) => {
      await lockAdvisoryKeys(tx, [key])
      locked()
      await held
    })
    await holding

    const productionTakes = runPgTransaction(prod, async (tx) => {
      await tx`SET LOCAL lock_timeout = '2s'`
      await lockAdvisoryKeys(tx, [key])
    })
    expect(await rejection(productionTakes)).toBe("resolved")
    release()
    await branchHolds

    // A few locks of its own, held as long as it likes, are no one else's business.
    const session = await branch.reserve()
    cleanups.push(async () => session.release())
    await session`SELECT pg_advisory_lock(g) FROM generate_series(1, 8) g`
    expect(await storage.enforceHostedBranchLimits("feature-a")).toEqual({
      stopped: 0,
      closed: null,
    })
    expect([...(await session<{ ok: number }[]>`SELECT 1 AS ok`)]).toEqual([{ ok: 1 }])
  })

  // Every database of the instance shares one lock table, sized for 64 locks per connection by
  // default: a session taking 15,000 advisory keys fills it, and production's next connections
  // fail with "out of shared memory". Reproduce that by hand, never in this suite, whose other
  // tests share the instance.
  // Guard check: drop the `advisory` clause from `closureOf`.
  test("closes the branch when one of its sessions holds more advisory locks than it needs", async () => {
    const { storage, admin } = await production()
    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")
    const name = await storage.hostedBranchRole("feature-a")

    const session = await sql.reserve()
    await session`SELECT pg_try_advisory_lock(g) FROM generate_series(1, 200) g`

    expect(await storage.enforceHostedBranchLimits("feature-a")).toEqual({
      stopped: 1,
      closed: { reason: "locks", locks: 200 },
    })
    expect(await rejection(session`SELECT 1`)).not.toBe("resolved")
    expect((await role(admin, name))?.login).toBe(false)
  })

  // Relation locks fill the same table as advisory keys: sessions locking thousands of their
  // own tables in a transaction each fill it just as surely. A load holds far less (three types
  // in the load test below, which `enforce` leaves alone).
  // Guard check: drop the `LOCK_TABLE_SHARES.branch` clause from `lockTableClosure`.
  test("closes the branch whose sessions together hold more than its share of the lock table", async () => {
    const { storage, admin } = await production()
    await hosted(storage, "feature-a")
    const capacity = await lockTable(admin)

    // Three sessions, each under the branch's share, all three past it.
    const each = Math.ceil(capacity / 4 / 3) + 20
    const { sql, login } = await asRole(storage, "feature-a")
    await createTables(sql, 3 * each)
    const sessions = await Promise.all(
      [0, 1, 2].map((index) => lockTables(login.url, index * each, each))
    )

    const { closed } = await storage.enforceHostedBranchLimits("feature-a")
    expect(closed).toMatchObject({ reason: "locks" })
    expect((closed as { locks: number }).locks).toBeGreaterThan(capacity / 4)
    expect(await rejection(sessions[0]!`SELECT 1`)).not.toBe("resolved")
  }, 30_000)

  // Two branches, each within its share, together past what branches may hold.
  // Guard check: drop the `LOCK_TABLE_SHARES.branches` clause from `lockTableClosure`.
  test("closes the branch holding the most once all branches together hold too much", async () => {
    const { storage, admin } = await production()
    await hosted(storage, "feature-a")
    await hosted(storage, "feature-b")
    const capacity = await lockTable(admin)

    const holds = async (name: string, share: number) => {
      const each = Math.ceil((capacity * share) / 2)
      const { sql, login } = await asRole(storage, name)
      await createTables(sql, 2 * each)
      return Promise.all([0, 1].map((index) => lockTables(login.url, index * each, each)))
    }
    // Kept: a session nothing refers to any more is collected, and its transaction ends.
    const sessions = [...(await holds("feature-a", 0.22)), ...(await holds("feature-b", 0.19))]

    expect(await storage.enforceHostedBranchLimits("feature-b")).toEqual({
      stopped: 0,
      closed: null,
    })
    expect((await storage.enforceHostedBranchLimits("feature-a")).closed).toMatchObject({
      reason: "crowded",
    })

    expect(await rejection(sessions[0]!`SELECT 1`)).not.toBe("resolved")
    expect([...(await sessions[2]!<{ ok: number }[]>`SELECT 1 AS ok`)]).toEqual([{ ok: 1 }])

    // Its sessions end too, before the test's clients close on them.
    await storage.closeHostedBranch("feature-b")
  }, 30_000)

  // Guard check: drop the `blocking` clause from `closureOf`.
  test("closes the branch when one of its sessions holds up another role's session", async () => {
    const { storage, admin, connectionString } = await production()
    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")
    const name = await storage.hostedBranchRole("feature-a")

    await sql`CREATE TABLE own_table (id int)`
    const session = await sql.reserve()
    await session`BEGIN`
    await session`LOCK TABLE own_table IN ACCESS EXCLUSIVE MODE`
    const inBranch = adminOn(connectionString, name)
    const waiting = rejection(inBranch`SELECT count(*) FROM public.own_table`)
    await until(async () => {
      const rows = await admin`
        SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = ${name}
      `
      return rows.length > 0
    })

    expect(await storage.enforceHostedBranchLimits("feature-a")).toEqual({
      stopped: 1,
      closed: { reason: "blocking" },
    })
    expect(await waiting).toBe("resolved")
  })

  // PostgreSQL lets every role connect to a database that did not revoke `CONNECT` from
  // `PUBLIC`, such as the cluster's `postgres`: there it reads that database's statistics.
  // Guard check: drop the `elsewhere` clause from `closureOf`.
  test("closes the branch when one of its sessions connects to another database", async () => {
    const { storage } = await production()
    await hosted(storage, "feature-a")
    const login = await storage.openHostedBranch("feature-a")

    const url = new URL(login.url)
    url.pathname = "/postgres"
    const elsewhere = new Bun.SQL(url.toString(), { max: 1 })
    cleanups.push(() => elsewhere.close())
    const session = await elsewhere.reserve()
    await session`SELECT pg_advisory_lock(42)`

    expect(await storage.enforceHostedBranchLimits("feature-a")).toEqual({
      stopped: 1,
      closed: { reason: "elsewhere", database: "postgres" },
    })
    expect(await rejection(session`SELECT 1`)).not.toBe("resolved")
  })

  // A copy and what the branch writes after it fill production's disk.
  // Guard check: return null from `slowCheck` before it compares the size to the limit.
  test("closes the branch once its database grows past its size limit", async () => {
    const { storage, admin, connectionString, schemaName } = await production()
    await hosted(storage, "feature-a")
    await runtime(storage, "feature-a")
    const name = await storage.hostedBranchRole("feature-a")

    expect(await storage.enforceHostedBranchLimits("feature-a")).toEqual({
      stopped: 0,
      closed: null,
    })

    // A storage that has not measured it yet, as a worker that just took the branch.
    const worker = new PostgresStorage({ connectionString, schemaName, max: 2 })
    cleanups.push(() => worker.close())
    const result = await worker.enforceHostedBranchLimits("feature-a", { databaseSizeLimitMb: 1 })

    expect(result.closed).toMatchObject({ reason: "disk", limitBytes: 1024 * 1024 })
    expect((await role(admin, name))?.login).toBe(false)
  })

  // A copy waits on a lane that has nothing to do while the others copy and index: at volume,
  // longer than the role's idle limit, which ended the lane's session and failed the load.
  // Guard check: drop the heartbeat from `PgSnapshotLoad.run`.
  test("loads a copy whose lanes wait inside their transactions longer than the idle limit", async () => {
    const { storage, admin } = await production()
    await hosted(storage, "feature-a", { idleInTransactionMillis: 1_000 })
    const branch = await (await runtime(storage, "feature-a", 4)).createBranchNamespace("copy")
    const name = await storage.hostedBranchRole("feature-a")

    const closures: unknown[] = []
    const loaded = await loadWaiting(branch, async () => {
      // Twice the limit, by the server's clock, with production holding the role to it.
      await until(async () => {
        const { closed } = await storage.enforceHostedBranchLimits("feature-a", {
          idleInTransactionMillis: 1_000,
        })
        closures.push(closed)
        const rows = await admin`
          SELECT 1 FROM pg_stat_activity
          WHERE usename = ${name} AND now() - xact_start > interval '2 s'
        `
        return rows.length >= 2
      }, 10_000)
    })

    expect(loaded).toBe("loaded")
    // Its lanes' locks, one per partition and index of three types, close nothing.
    expect(closures.filter((closed) => closed !== null)).toEqual([])
  }, 30_000)

  // Guard check: drop the `REVOKE … FROM PUBLIC` from `create`: anyone may then connect.
  test("lets its role reach its own database and nothing of production's, and no one else in", async () => {
    const { storage, admin, schemaName, connectionString } = await production()
    await hosted(storage, "feature-a")
    const { sql, login } = await asRole(storage, "feature-a")

    expect(
      await rejection(sql.unsafe(`SELECT * FROM ${quoteIdent(schemaName)}.sixb_migrations`))
    ).toContain("does not exist")
    const productionDatabase = new URL(login.url)
    productionDatabase.pathname = new URL(connectionString).pathname
    const intoProduction = new Bun.SQL(productionDatabase.toString(), { max: 1 })
    cleanups.push(() => intoProduction.close())
    expect(await rejection(intoProduction`SELECT 1`)).toContain("permission denied for database")
    expect(await rejection(sql`SET ROLE postgres`)).toContain("permission denied")
    expect(await sql`CREATE TABLE own_table (id int)`).toBeDefined()

    const outsider = `sixb_outsider_${randomUUID().slice(0, 8)}`
    await admin.unsafe(`CREATE ROLE ${outsider} LOGIN PASSWORD 'outsider'`)
    cleanups.push(() => admin.unsafe(`DROP ROLE ${outsider}`))
    const url = new URL(login.url)
    url.username = outsider
    url.password = "outsider"
    const intruder = new Bun.SQL(url.toString(), { max: 1 })
    cleanups.push(() => intruder.close())
    expect(await rejection(intruder`SELECT 1`)).toContain("permission denied for database")
  })

  // Guard check: hash the namespace alone in `hostedBranchRoleName`: the second database's
  // branch then finds the first's role, since roles span the cluster.
  test("names its role and database in 63 bytes, apart from every other database's", async () => {
    const first = await production()
    const second = await production()
    const name = `${"a".repeat(31)}-0123456`

    await hosted(first.storage, name)
    await hosted(second.storage, name)
    const names = [
      await first.storage.hostedBranchRole(name),
      await second.storage.hostedBranchRole(name),
    ]

    expect(new Set(names).size).toBe(2)
    for (const role of names) expect(Buffer.byteLength(role)).toBeLessThanOrEqual(63)
    expect(
      hostedBranchRoleName({
        database: "d".repeat(200),
        productionSchema: "s".repeat(63),
        namespace: "x".repeat(40),
      }).length
    ).toBeLessThanOrEqual(63)
  })

  test("drops its database and its role, with a session still open", async () => {
    const { storage, admin } = await production()
    await storage.createHostedBranch("feature-a", {})
    await runtime(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")
    await sql`SELECT 1`
    const name = await storage.hostedBranchRole("feature-a")

    await storage.dropHostedBranch("feature-a")

    expect(await admin`SELECT 1 FROM pg_roles WHERE rolname = ${name}`).toHaveLength(0)
    expect(await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`).toHaveLength(0)
  })

  // Its owner may mark its database a template, which PostgreSQL refuses to drop.
  // Guard check: drop the `IS_TEMPLATE false` from `PgHostedBranches.drop`.
  test("drops a database its role made a template", async () => {
    const { storage, admin } = await production()
    await storage.createHostedBranch("feature-a", {})
    cleanups.push(() => storage.dropHostedBranch("feature-a"))
    const { sql } = await asRole(storage, "feature-a")
    const name = await storage.hostedBranchRole("feature-a")
    await sql.unsafe(`ALTER DATABASE ${quoteIdent(name)} IS_TEMPLATE true`)

    await storage.dropHostedBranch("feature-a")
    expect(await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`).toHaveLength(0)
  })

  // Guard checks: drop `close` from `PgHostedBranches.drop`, and the role logs in while its
  // database waits to be dropped; drop its `lock_timeout`, and the drop waits for good.
  test("logs its role in no more once a drop begins, and gives up on a database still locked", async () => {
    const { storage, admin } = await production()
    await storage.createHostedBranch("feature-a", {})
    cleanups.push(() => storage.dropHostedBranch("feature-a"))
    const name = await storage.hostedBranchRole("feature-a")
    const login = await storage.openHostedBranch("feature-a")

    const locker = await admin.reserve()
    cleanups.push(async () => locker.release())
    await locker`BEGIN`
    await locker.unsafe(`COMMENT ON DATABASE ${quoteIdent(name)} IS 'held'`)

    const dropping = rejection(storage.dropHostedBranch("feature-a"))
    await until(async () => {
      const rows = await admin`
        SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE 'DROP DATABASE%'
      `
      return rows.length > 0
    })

    const late = new Bun.SQL(login.url, { max: 1 })
    cleanups.push(() => late.close())
    expect(await rejection(late`SELECT 1`)).toContain("not permitted to log in")
    expect(await dropping).toContain("lock timeout")

    await locker`ROLLBACK`
    await storage.dropHostedBranch("feature-a")
    expect(await admin`SELECT 1 FROM pg_roles WHERE rolname = ${name}`).toHaveLength(0)
    // PostgreSQL's own lock timeout runs out: five seconds of it.
  }, 15_000)

  // A superuser's setting the role cannot raise caps what one of its sessions spills to disk.
  // Guard check: drop the `temp_file_limit` setting from `PgHostedBranches.create`.
  test("caps the temporary files its role's sessions write, whatever they SET", async () => {
    // Setting `temp_file_limit` takes a superuser, or one granted `SET` on it.
    const { storage } = await production({ superuser: true })
    await hosted(storage, "feature-a", { tempFileLimitKb: 1024 })
    const { sql } = await asRole(storage, "feature-a")
    const session = await sql.reserve()
    cleanups.push(async () => session.release())

    expect(await rejection(session`SET temp_file_limit = -1`)).toContain("permission denied")
    await session`SET work_mem = '64kB'`
    const spill = session`
      SELECT count(*) FROM (
        SELECT md5(g::text) AS v FROM generate_series(1, 200000) g ORDER BY v
      ) sorted
    `
    expect(await rejection(spill)).toContain("temp_file_limit")
  })

  // Managed PostgreSQL often keeps temp_file_limit to its superuser: production then says it
  // could not cap the role, rather than let the branch believe it is capped.
  // Guard check: return `{ tempFileLimit: true }` whatever `has_parameter_privilege` answers.
  test("says whether it could cap the temporary files of its role", async () => {
    const { storage, admin, connectionString, schemaName } = await production({ superuser: true })
    expect(await storage.createHostedBranch("feature-capped")).toEqual({ tempFileLimit: true })
    cleanups.push(() => storage.dropHostedBranch("feature-capped"))

    const limited = await productionAs(admin, connectionString, schemaName, "CREATEROLE CREATEDB")
    cleanups.push(() => limited.dropHostedBranch("feature-uncapped"))

    expect(await limited.createHostedBranch("feature-uncapped")).toEqual({ tempFileLimit: false })
  })

  // Each branch's database is new: a production that may not create one stops before it
  // changes anything, and says what it lacks.
  // Guard check: return null from `unmetRequirement` whatever the user's attributes.
  test("refuses up front a production that may not create databases, and says how to fix it", async () => {
    const { admin, connectionString, schemaName } = await production()
    const limited = await productionAs(admin, connectionString, schemaName, "CREATEROLE")
    const name = await limited.hostedBranchRole("feature-a")

    expect(await limited.unmetHostedBranchRequirement()).toContain("to have CREATEDB")
    expect(await rejection(limited.createHostedBranch("feature-a"))).toContain(
      "Hosted branches need production's database user"
    )
    expect(await role(admin, name)).toBeUndefined()
  })

  // A trusted extension a production that is no superuser creates for its branches too.
  test("creates pg_trgm in a branch's database as a production that is no superuser", async () => {
    const { storage, admin } = await production()
    await admin`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public`
    expect(await storage.unmetHostedBranchRequirement()).toBeNull()

    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")
    expect(await sql`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`).toHaveLength(1)
  })

  // Every role may connect to a database that did not revoke it from `PUBLIC`: in production's,
  // a branch's role would hold production's advisory keys and read its statistics.
  // Guard check: drop the `publicConnect` clause from `hostedBranchRequirement`.
  test("refuses a production database every role may connect to, and says how to close it", async () => {
    const { storage, admin, connectionString } = await production()
    const database = new URL(connectionString).pathname.slice(1)
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO PUBLIC`)

    expect(await storage.unmetHostedBranchRequirement()).toContain(
      `REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC`
    )
    expect(await rejection(storage.createHostedBranch("feature-a"))).toContain(
      `production's database '${database}' closed to PUBLIC`
    )
    expect(await role(admin, await storage.hostedBranchRole("feature-a"))).toBeUndefined()
  })

  // A copy's load takes locks by the type: one too large for a branch's share of the lock table
  // would close itself halfway through, so it never starts.
  // Guard check: drop the `objectTypes` clause from `hostedBranchRequirement`.
  test("refuses up front a copy whose load needs more of the lock table than a branch's share", async () => {
    const { storage } = await production()

    expect(await storage.unmetHostedBranchRequirement(60)).toBeNull()
    expect(await storage.unmetHostedBranchRequirement(400)).toContain(
      "Set max_locks_per_transaction = "
    )
    expect(
      await rejection(storage.createHostedBranch("feature-a", { objectTypes: 400 }))
    ).toContain("a larger lock table for a copy of 400 object types")
  })

  // A branch session holding its role's own row, an `ALTER ROLE` of its own left open, once made
  // production's NOLOGIN and login renewal wait for good, and the worker's limits with them.
  // Guard checks: drop the `lock_timeout` from `bounded`, and `close` waits for good; drop the
  // retry from `alterRole`, and it fails on the first lock timeout.
  test("closes, renews and opens a branch whose session holds its role's row", async () => {
    const { storage, admin } = await production()
    await hosted(storage, "feature-a")
    const name = await storage.hostedBranchRole("feature-a")

    const pin = async () => {
      const { sql } = await asRole(storage, "feature-a")
      const session = await sql.reserve()
      await session`SET idle_in_transaction_session_timeout = 0`
      await session`BEGIN`
      await session.unsafe("ALTER ROLE CURRENT_USER PASSWORD 'mine'")
      return session
    }

    const pinned = await pin()
    expect(await within(storage.enforceHostedBranchLimits("feature-a"))).toEqual({
      stopped: 0,
      closed: null,
    })
    expect(await rejection(pinned`SELECT 1`)).not.toBe("resolved")

    await pin()
    expect(await within(storage.openHostedBranch("feature-a").then(() => "opened"))).toBe("opened")

    await pin()
    expect(await within(storage.closeHostedBranch("feature-a").then(() => "closed"))).toBe("closed")
    expect((await role(admin, name))?.login).toBe(false)
  }, 30_000)

  // A large object made where `PUBLIC` may connect, the cluster's `postgres` here, once kept
  // `DROP ROLE` failing for good: no refresh, no delete.
  // Guard check: drop `dropOwnedElsewhere` from `PgHostedBranches.drop`.
  test("drops a role that owns objects in another database of the instance", async () => {
    const { storage, admin } = await production({ superuser: true })
    await storage.createHostedBranch("feature-a", {})
    cleanups.push(() => storage.dropHostedBranch("feature-a"))
    const name = await storage.hostedBranchRole("feature-a")
    const login = await storage.openHostedBranch("feature-a")

    const url = new URL(login.url)
    url.pathname = "/postgres"
    const elsewhere = new Bun.SQL(url.toString(), { max: 1 })
    await elsewhere`SELECT lo_create(0)`
    await elsewhere.close()

    await storage.dropHostedBranch("feature-a")
    expect(await role(admin, name)).toBeUndefined()
  })

  // Once its database nears its limit, a minute is long enough to fill what is left.
  // Guard check: drop the `SIZE_WATCH_SHARE` clause from `slowCheck`.
  test("measures a database near its size limit every round", async () => {
    const { storage } = await production()
    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")
    const name = await storage.hostedBranchRole("feature-a")

    const [size] = (await sql`
      SELECT pg_database_size(current_database())::bigint AS bytes
    `) as { bytes: string }[]
    // 90% of the limit now, past it once the table below is in.
    const limitMb = Math.ceil(Number(size!.bytes) / 0.9 / 1024 / 1024)
    expect(
      await storage.enforceHostedBranchLimits("feature-a", { databaseSizeLimitMb: limitMb })
    ).toEqual({ stopped: 0, closed: null })

    await sql`CREATE TABLE fill AS SELECT repeat('x', 1000) AS v FROM generate_series(1, 4000)`
    const { closed } = await storage.enforceHostedBranchLimits("feature-a", {
      databaseSizeLimitMb: limitMb,
    })
    expect(closed).toMatchObject({ reason: "disk" })
    expect(name).toStartWith("sixb_branch_feature_a_")
  })

  // A copy of many types holds a lock per partition and index on each lane, more than a quarter
  // of the default table at 150 types and more: what the branch may hold is sized for the copy,
  // and a copy too large for it is refused before it starts.
  test("leaves open a copy of 60 types while it loads", async () => {
    const { storage } = await production()
    expect(await storage.unmetHostedBranchRequirement(60)).toBeNull()
    await hosted(storage, "feature-a", { objectTypes: 60 })
    const branch = await (await runtime(storage, "feature-a", 4)).createBranchNamespace("copy")

    const closures: unknown[] = []
    const loaded = await loadWaiting(
      branch,
      async () => {
        for (let round = 0; round < 5; round += 1) {
          const { closed } = await storage.enforceHostedBranchLimits("feature-a", {
            objectTypes: 60,
          })
          closures.push(closed)
        }
      },
      60
    )

    expect(loaded).toBe("loaded")
    expect(closures).toEqual([null, null, null, null, null])
  }, 60_000)
})

/** Production as a user that is no superuser, with `attributes`, on the same database. */
async function productionAs(
  admin: Bun.SQL,
  connectionString: string,
  schemaName: string,
  attributes: string
): Promise<PostgresStorage> {
  const user = `sixb_prod_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  const database = quoteIdent(new URL(connectionString).pathname.slice(1))
  await admin.unsafe(`CREATE ROLE ${user} LOGIN ${attributes} PASSWORD 'prod'`)
  await admin.unsafe(`GRANT CONNECT, CREATE ON DATABASE ${database} TO ${user}`)
  await admin.unsafe(`GRANT ALL ON SCHEMA ${quoteIdent(schemaName)} TO ${user}`)

  const url = new URL(connectionString)
  url.username = user
  url.password = "prod"
  const storage = new PostgresStorage({ connectionString: url.toString(), schemaName, max: 2 })
  cleanups.push(async () => {
    await storage.close()
    await admin.unsafe(`DROP OWNED BY ${user}`)
    await admin.unsafe(`DROP ROLE ${user}`)
  })
  return storage
}

/** How many locks the instance's shared lock table holds. */
async function lockTable(admin: Bun.SQL): Promise<number> {
  const [row] = (await admin`
    SELECT current_setting('max_locks_per_transaction')::int * (
      current_setting('max_connections')::int + current_setting('max_prepared_transactions')::int
    ) AS capacity
  `) as { capacity: number }[]
  return row!.capacity
}

/** `count` tables of the branch's own, in batches: creating them takes locks too. */
async function createTables(sql: Bun.SQL, count: number): Promise<void> {
  for (let from = 0; from < count; from += 500) {
    await sql.unsafe(`
      DO $$ BEGIN
        FOR i IN ${from}..${Math.min(from + 499, count - 1)} LOOP
          EXECUTE format('CREATE TABLE own_%s (id int)', i);
        END LOOP;
      END $$
    `)
  }
}

/**
 * A session of its own, on the branch's login, holding `count` of those tables locked in a
 * transaction: all but the 16 fast-path ones in the shared lock table.
 */
async function lockTables(url: string, from: number, count: number) {
  const sql = new Bun.SQL(url, { max: 1 })
  cleanups.push(() => sql.close())
  const session = await sql.reserve()
  await session`BEGIN`
  await session.unsafe(`
    DO $$ BEGIN
      FOR i IN ${from}..${from + count - 1} LOOP
        EXECUTE format('LOCK TABLE own_%s IN ACCESS SHARE MODE', i);
      END LOOP;
    END $$
  `)
  return session
}

/**
 * Loads an object of each of `types` types, then waits on `hold` before the load ends: its other
 * lanes sit idle. Settles within 10 s, or says it is still loading.
 */
async function loadWaiting(
  branch: Awaited<ReturnType<PostgresStorage["createBranchNamespace"]>>,
  hold: () => Promise<void>,
  types = 3
): Promise<string> {
  const objectTypeIds = Array.from({ length: types }, (_, index) => `Type${index}`)
  const id = "snapshot_idle"
  const at = "2026-01-01T00:00:00.000Z"
  const operation = { type: "ontology.loadSnapshot", snapshotId: id } as const
  await branch.executions.create({
    id: `exec_${id}`,
    projectId: "shop",
    executor: { type: "kernel", operation },
    source: { type: "http", requestId: id },
    correlationId: id,
    authorizationRef: { type: "kernel", operation },
  })

  const load = branch.loadSnapshot(
    {
      projectId: "shop",
      commit: {
        projectId: "shop",
        id,
        idempotencyKey: id,
        requestHash: id,
        executionId: `exec_${id}`,
        origin: { kind: "runtime", requestId: id },
        ontologyRevision: "revision",
        committedAt: at,
        intent: { kind: "edit", mode: "atomic", operationCount: 0 },
        result: {
          kind: "edit",
          commitId: id,
          created: true,
          eventCount: 0,
          committedAt: at,
          outcomes: [],
          changes: { objects: [], links: [] },
        },
      },
      uniqueProperties: [],
      objectTypeIds,
    },
    async (loader) => {
      await loader.write({
        objects: objectTypeIds.map((objectTypeId) => ({
          objectTypeId,
          primaryId: `${objectTypeId}-1`,
          properties: { id: `${objectTypeId}-1` },
          createdAt: at,
          updatedAt: at,
        })),
      })
      await hold()
    }
  )
  return within(
    load.then(
      () => "loaded",
      (error: unknown) => String(error)
    ),
    10_000,
    "still loading"
  )
}

/** `work`, or a named failure once `timeoutMs` passes: a guard taken out fails by name. */
async function within<T>(
  work: Promise<T>,
  timeoutMs = 10_000,
  late = "still waiting"
): Promise<T | string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`${late} after ${timeoutMs} ms`), timeoutMs)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function until(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the role's session.")
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
