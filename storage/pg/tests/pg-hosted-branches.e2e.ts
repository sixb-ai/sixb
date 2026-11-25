import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { PostgresStorage } from "../src"
import { hostedBranchRoleName, SCRAM_ITERATIONS } from "../src/hosted-branches"
import { postgresMigrationLock, postgresStorageMigrations, quoteIdent } from "../src/migrations"
import { createPgClient } from "../src/pg-client"
import { authLockKey, lockAdvisoryKeys, runPgTransaction } from "../src/transactions"
import { createTestStorage, disposeTestStorage } from "./helpers"

// A hosted branch's schema and role on production's instance, checked against PostgreSQL itself:
// each property below fails if the code that gives it is taken out.

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
})

async function production() {
  const test = await createTestStorage()
  cleanups.push(() => disposeTestStorage(test.storage))
  const admin = new Bun.SQL(test.connectionString)
  cleanups.push(() => admin.close())
  return { ...test, admin }
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

/** The branch's runtime, migrating its own schema as its role. */
async function runtime(storage: PostgresStorage, name: string) {
  const login = await storage.openHostedBranch(name)
  const branch = new PostgresStorage({
    connectionString: login.url,
    schemaName: login.schemaName,
    max: 2,
  })
  cleanups.push(() => branch.close())
  for (const migrator of branch.migrators) await migrator.migrate()
  return branch
}

async function rejection(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => "resolved",
    (error: unknown) => String(error)
  )
}

describe("a hosted branch's schema", () => {
  // Guard check: drop `AUTHORIZATION` from the schema's DDL in `PgHostedBranches.create`: the
  // schema then belongs to production, and so would anything production ran in it.
  test("belongs to the branch's role, empty until the branch's runtime migrates it as the role", async () => {
    const { storage, admin } = await production()
    await hosted(storage, "feature-a")
    const role = await storage.hostedBranchRole("feature-a")

    const relations = () => admin<{ relname: string; owner: string }[]>`
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${role}
    `
    const [schema] = await admin<{ owner: string }[]>`
      SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ${role}
    `
    expect(schema?.owner).toBe(role)
    expect(await relations()).toHaveLength(0)

    await runtime(storage, "feature-a")
    const owners = new Set((await relations()).map((row) => row.owner))
    expect([...owners]).toEqual([role])
  })

  // Guard check: put the plain password in `PgHostedBranches.open`'s DDL: the server then hashes
  // it with its own 4096 iterations.
  test("logs its role in with a verifier production computed, never a plain password in DDL", async () => {
    const { storage, admin } = await production()
    const role = await storage.hostedBranchRole("feature-a")
    const stored = async () =>
      (
        (await admin`SELECT rolpassword FROM pg_authid WHERE rolname = ${role}`) as {
          rolpassword: string | null
        }[]
      )[0]?.rolpassword

    await hosted(storage, "feature-a")
    expect(await stored()).toBeNull()

    const { sql } = await asRole(storage, "feature-a")
    expect(await sql`SELECT current_user AS name`).toEqual([{ name: role }])
    const first = await stored()
    await storage.openHostedBranch("feature-a")

    expect(first).toStartWith(`SCRAM-SHA-256$${SCRAM_ITERATIONS}:`)
    expect(await stored()).toStartWith(`SCRAM-SHA-256$${SCRAM_ITERATIONS}:`)
    expect(await stored()).not.toBe(first)
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
    const role = await storage.hostedBranchRole("feature-a")

    const statement = await sql.reserve()
    await statement`SET statement_timeout = 0`
    const sleeping = rejection(statement`SELECT pg_sleep(5)`)
    await until(async () => {
      const rows = await admin`
        SELECT 1 FROM pg_stat_activity
        WHERE usename = ${role} AND state = 'active' AND now() - query_start > interval '150 ms'
      `
      return rows.length > 0
    })

    expect(
      await storage.enforceHostedBranchLimits("feature-a", { statementTimeoutMillis: 100 })
    ).toBe(1)
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
        WHERE usename = ${role} AND now() - xact_start > interval '150 ms'
      `
      return rows.length > 0
    })

    await storage.enforceHostedBranchLimits("feature-a", { transactionTimeoutMillis: 100 })
    expect(await rejection(held`SELECT 1`)).not.toBe("resolved")
  })

  // A branch holding production's migration lock would stop every deploy of production's.
  // Guard check: drop `production_lock` from the terminating condition in `enforce`.
  test("ends at once a session of its role that holds one of production's advisory locks", async () => {
    const { storage, schemaName } = await production()
    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")
    const [first, second] = postgresMigrationLock(schemaName, postgresStorageMigrations.adapterId)

    const session = await sql.reserve()
    await session`SELECT pg_advisory_lock(${first}::int, ${second}::int)`

    expect(await storage.enforceHostedBranchLimits("feature-a", {})).toBe(1)
    expect(await rejection(session`SELECT 1`)).not.toBe("resolved")
  })

  // The extension's creation lock spans the database: a branch holding it stops production's.
  // Guard check: leave `texts` out of the `production_lock` condition in `enforce`.
  test("ends at once a session of its role that holds a database-wide lock of the framework's", async () => {
    const { storage } = await production()
    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")

    const session = await sql.reserve()
    await session`SELECT pg_advisory_lock(hashtextextended('sixb.extension.pg_trgm', 0))`

    expect(await storage.enforceHostedBranchLimits("feature-a", {})).toBe(1)
    expect(await rejection(session`SELECT 1`)).not.toBe("resolved")
  })

  // The branch runs the same code on the same project: its keys were production's keys, so an
  // auth or artifact lock it held made production wait.
  // Guard check: hash the key alone, without `current_schema()`, in `lockAdvisoryKeys`.
  test("takes its own advisory locks apart from production's, and keeps them", async () => {
    const { storage, connectionString, schemaName } = await production()
    await hosted(storage, "feature-a")
    await runtime(storage, "feature-a")
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
    const productionHolds = runPgTransaction(prod, async (tx) => {
      await lockAdvisoryKeys(tx, [key])
      locked()
      await held
    })
    await holding

    const branchTakes = runPgTransaction(branch, async (tx) => {
      await tx`SET LOCAL lock_timeout = '2s'`
      await lockAdvisoryKeys(tx, [key])
      return "locked"
    })
    expect(await rejection(branchTakes)).toBe("resolved")
    release()
    await productionHolds

    // Its own locks, held as long as it likes, are no one else's business.
    const { sql } = await asRole(storage, "feature-a")
    const session = await sql.reserve()
    await session`SELECT pg_advisory_lock(42)`
    expect(
      await storage.enforceHostedBranchLimits("feature-a", { statementTimeoutMillis: 1 })
    ).toBe(0)
    expect(await session`SELECT 1 AS ok`).toEqual([{ ok: 1 }])
    session.release()
  })

  // An open transaction holds back vacuum on production's whole instance.
  // Guard check: drop the idle-in-transaction clause from `ended` in `enforce`.
  test("ends a session of its role idle in a transaction past the limit, whatever it SET", async () => {
    const { storage, admin } = await production()
    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")
    const role = await storage.hostedBranchRole("feature-a")

    const session = await sql.reserve()
    await session`SET idle_in_transaction_session_timeout = 0`
    await session`BEGIN`
    await session`SELECT 1`
    await until(async () => {
      const rows = await admin`
        SELECT 1 FROM pg_stat_activity
        WHERE usename = ${role} AND state = 'idle in transaction'
          AND now() - state_change > interval '150 ms'
      `
      return rows.length > 0
    })

    expect(
      await storage.enforceHostedBranchLimits("feature-a", { idleInTransactionMillis: 100 })
    ).toBe(1)
    expect(await rejection(session`SELECT 1`)).not.toBe("resolved")
  })

  // A superuser's setting the role cannot raise caps what one of its sessions spills to disk.
  // Guard check: drop the `temp_file_limit` setting from `PgHostedBranches.create`.
  test("caps the temporary files its role's sessions write, whatever they SET", async () => {
    const { storage } = await production()
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
    const { storage, admin, connectionString, schemaName } = await production()
    expect(await storage.createHostedBranch("feature-capped")).toEqual({ tempFileLimit: true })
    cleanups.push(() => storage.dropHostedBranch("feature-capped"))

    // Production as a role that may create roles, but not set temp_file_limit.
    const user = `sixb_prod_${randomUUID().slice(0, 8)}`
    await admin.unsafe(`CREATE ROLE ${user} LOGIN CREATEROLE PASSWORD 'prod'`)
    await admin.unsafe(
      `GRANT CREATE ON DATABASE ${quoteIdent(new URL(connectionString).pathname.slice(1))} TO ${user}`
    )
    await admin.unsafe(`GRANT ALL ON SCHEMA ${quoteIdent(schemaName)} TO ${user}`)
    const url = new URL(connectionString)
    url.username = user
    url.password = "prod"
    const limited = new PostgresStorage({ connectionString: url.toString(), schemaName, max: 2 })
    cleanups.push(async () => {
      await limited.dropHostedBranch("feature-uncapped").catch(() => {})
      await limited.close()
      await admin.unsafe(`DROP OWNED BY ${user}`)
      await admin.unsafe(`DROP ROLE ${user}`)
    })

    expect(await limited.createHostedBranch("feature-uncapped")).toEqual({ tempFileLimit: false })
  })

  // Guard check: give the role CREATE on the database, or any grant on production's schema.
  test("lets its role reach its own schema and nothing of production's", async () => {
    const { storage, schemaName } = await production()
    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")

    expect(
      await rejection(sql.unsafe(`SELECT * FROM ${quoteIdent(schemaName)}.sixb_migrations`))
    ).toContain("permission denied")
    expect(await rejection(sql`CREATE SCHEMA escape`)).toContain("permission denied")
    expect(await rejection(sql`CREATE TABLE public.escape (id int)`)).toContain("permission denied")
    expect(await rejection(sql`SET ROLE postgres`)).toContain("permission denied")
    expect(await sql`CREATE TABLE own_table (id int)`).toBeDefined()
  })

  // Guard check: hash the namespace alone in `hostedBranchRoleName`: the second database's
  // branch then finds the first's role, since roles span the cluster.
  test("names its role and schema in 63 bytes, apart from every other database's", async () => {
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

  test("drops its schema and its role, with a session still open", async () => {
    const { storage, admin } = await production()
    await storage.createHostedBranch("feature-a", {})
    await runtime(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")
    await sql`SELECT 1`
    const role = await storage.hostedBranchRole("feature-a")

    await storage.dropHostedBranch("feature-a")

    expect(await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`).toHaveLength(0)
    expect(await admin`SELECT 1 FROM pg_namespace WHERE nspname = ${role}`).toHaveLength(0)
  })

  // Guard checks: drop `NOLOGIN` from `PgHostedBranches.drop`, and the role logs in while its
  // schema waits to be dropped; drop its `lock_timeout`, and the drop waits for good.
  test("logs its role in no more once a drop begins, and gives up on a schema still locked", async () => {
    const { storage, admin } = await production()
    await storage.createHostedBranch("feature-a", {})
    cleanups.push(() => storage.dropHostedBranch("feature-a"))
    await runtime(storage, "feature-a")
    const role = await storage.hostedBranchRole("feature-a")
    const login = await storage.openHostedBranch("feature-a")

    const locker = await admin.reserve()
    cleanups.push(async () => locker.release())
    await locker`BEGIN`
    await locker.unsafe(`LOCK TABLE ${quoteIdent(role)}.objects IN ACCESS SHARE MODE`)

    const dropping = rejection(storage.dropHostedBranch("feature-a"))
    await until(async () => {
      const rows = await admin`
        SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE 'DROP SCHEMA%'
      `
      return rows.length > 0
    })

    const late = new Bun.SQL(login.url, { max: 1 })
    cleanups.push(() => late.close())
    expect(await rejection(late`SELECT 1`)).toContain("not permitted to log in")
    expect(await dropping).toContain("lock timeout")

    await locker`ROLLBACK`
    await storage.dropHostedBranch("feature-a")
    expect(await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`).toHaveLength(0)
    // PostgreSQL's own lock timeout runs out: five seconds of it.
  }, 15_000)

  // A production that is no superuser, as on a managed instance: what it creates roles with.
  test("is hosted by a production that may create roles but is no superuser", async () => {
    const { connectionString, admin } = await production()

    const owner = `sixb_prod_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    const [{ database }] = (await admin`SELECT current_database() AS database`) as [
      { database: string },
    ]
    await admin.unsafe(`CREATE ROLE ${owner} LOGIN CREATEROLE PASSWORD 'prod'`)
    await admin.unsafe(`ALTER DATABASE ${quoteIdent(database)} OWNER TO ${owner}`)
    cleanups.push(async () => {
      await admin.unsafe(`ALTER DATABASE ${quoteIdent(database)} OWNER TO postgres`)
      await admin.unsafe(`DROP OWNED BY ${owner}`)
      await admin.unsafe(`DROP ROLE ${owner}`)
    })

    const url = new URL(connectionString)
    url.username = owner
    url.password = "prod"
    const storage = new PostgresStorage({ connectionString: url.toString(), schemaName: "prod" })
    cleanups.push(() => storage.close())
    for (const migrator of storage.migrators) await migrator.migrate()

    await hosted(storage, "feature-a")
    const { sql } = await asRole(storage, "feature-a")
    expect(await sql`SELECT 1 AS ok`).toEqual([{ ok: 1 }])
    expect(await storage.enforceHostedBranchLimits("feature-a", {})).toBe(0)

    await storage.dropHostedBranch("feature-a")
    expect(
      await admin`SELECT 1 FROM pg_roles WHERE rolname LIKE 'sixb_branch_feature_a_%'`
    ).toHaveLength(0)
  })
})

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the role's session.")
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
