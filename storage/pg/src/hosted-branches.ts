import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto"
import { assertBranchNamespaceName } from "@sixb/core/internal/storage"
import { quoteIdent } from "./migrations"
import type { SQL, SQLClient } from "./pg-client"
import { pgErrorCode } from "./storage-errors"
import { runPgTransaction, withReservedPgConnection } from "./transactions"

/**
 * A hosted branch's home on production's instance: a database of its own, owned by a role of its
 * own that logs in to it alone. `packages/core/src/branches/README.md`, "Production's instance",
 * says what holds and why.
 *
 * Production creates the role and the database, and in it only the extensions its own storage
 * uses. The branch's runtime migrates the database and loads its copy, as the role. Production
 * never runs its own migrations or DDL there, so nothing the branch plants in it ever runs with
 * production's privileges. Afterwards production only watches the role's sessions, takes its
 * login away, and drops the database, `DROP DATABASE … WITH (FORCE)`, then the role. Every one
 * of its statements that waits on a lock waits a bounded time: a branch holding the role's own
 * row, or its database's, never stalls production.
 */

/** What a hosted branch's role may take from production's instance. */
export interface HostedBranchLimits {
  /** Connections the role may hold at once. Defaults to 5. */
  readonly connectionLimit?: number
  /**
   * Longest statement, in ms, before production cancels it. Defaults to 15 minutes: long enough
   * for the framework's own work at volume, such as an index build or a partition move.
   */
  readonly statementTimeoutMillis?: number
  /**
   * Longest transaction, in ms, before production ends its session. Defaults to 30 minutes: an
   * open transaction holds back vacuum on production's whole instance.
   */
  readonly transactionTimeoutMillis?: number
  /** Longest wait inside an open transaction, in ms, before production ends it. Defaults to 60 s. */
  readonly idleInTransactionMillis?: number
  /**
   * Temporary files one of its sessions may write, in kB. Defaults to 1 GiB. Applied when
   * production may set `temp_file_limit` (a superuser, or one granted `SET` on it).
   */
  readonly tempFileLimitKb?: number
  /**
   * What the branch's database may hold on production's disk, in MB, its copy included. Defaults
   * to twice production's own database, at least 20 GiB: a copy is at most what production holds.
   * Past it, production takes the role's login away.
   */
  readonly databaseSizeLimitMb?: number
  /**
   * The object types its copy loads, which sizes the locks its load takes: a copy too large for
   * a branch's share of the lock table is refused before it starts.
   */
  readonly objectTypes?: number
}

/** How production connects: a branch's login copies it, but for its user, password and database. */
export interface HostedBranchConnection {
  readonly connectionString?: string
  readonly host?: string
  readonly port?: number
  readonly database?: string
  readonly ssl?: boolean | "require" | "prefer"
}

export interface HostedBranchLogin {
  /** Production's instance, as the role, on the branch's own database. */
  readonly url: string
  /** The schema the branch's runtime makes in its database: production's own name for it. */
  readonly schemaName: string
}

/** What one round of `enforce` did. */
export interface HostedBranchEnforcement {
  /** The statements it cancelled and the sessions it ended. */
  readonly stopped: number
  /**
   * Set when it took the role's login away, and why: the branch stays shut out until it is
   * opened again, with a new login.
   */
  readonly closed: HostedBranchClosure | null
}

/** Why production took a branch's login away. */
export type HostedBranchClosure =
  /** It held more advisory locks, or more of the lock table, than the framework ever takes. */
  | { readonly reason: "locks"; readonly locks: number }
  /** Branches together held more of the lock table than they may, and it held the most. */
  | { readonly reason: "crowded"; readonly locks: number }
  /** A session held a lock that another role's session waited for. */
  | { readonly reason: "blocking" }
  /** A session was connected to another database than the branch's own. */
  | { readonly reason: "elsewhere"; readonly database: string }
  /** The branch's database grew past its size limit. */
  | { readonly reason: "disk"; readonly bytes: number; readonly limitBytes: number }

const ROLE_PREFIX = "sixb_branch_"
const MAX_IDENTIFIER_BYTES = 63
const HASH_LENGTH = 12
/** Above PostgreSQL's default of 4096: a verifier production computed, not the server. */
export const SCRAM_ITERATIONS = 15_000

const DEFAULT_LIMITS = {
  connectionLimit: 5,
  statementTimeoutMillis: 15 * 60_000,
  transactionTimeoutMillis: 30 * 60_000,
  idleInTransactionMillis: 60_000,
  tempFileLimitKb: 1024 * 1024,
  /** The floor of the default size limit, which is twice production's database. */
  databaseSizeLimitMb: 20 * 1024,
} as const

/** The extensions production's storage uses, which a branch cannot create itself. */
const EXTENSIONS = ["pg_trgm", "vector"] as const

/**
 * Advisory locks one session of the branch's may hold. The framework takes a few. PostgreSQL keeps
 * every lock in one table, shared by all the instance's databases and sized for
 * `max_locks_per_transaction` (64 by default) per connection: a session that fills it stops every
 * new connection to production with "out of shared memory".
 */
const ADVISORY_LOCKS_PER_SESSION = 64

/**
 * Shares of the lock table branches may hold, locks of every kind but fast-path ones, which live
 * outside it. The table holds `max_locks_per_transaction` × (`max_connections` +
 * `max_prepared_transactions`): 6,400 by default. One branch, all its sessions together, holds at
 * most a quarter of it. All branches together hold at most three eighths, which two branches at
 * their full share already pass: past it, the branch holding the most closes. Production always
 * keeps more than half. A branch's share stays a quarter however large its ontology: one whose
 * load would need more is refused up front (`LOAD_LOCKS`), never closed halfway through its load.
 */
const LOCK_TABLE_SHARES = { branch: 1 / 4, branches: 3 / 8 } as const

/**
 * The most locks a copy's load holds, all its sessions together, for its object types: one per
 * partition and index, on two lanes. Measured at 175 for 3 types, 530 for 30, and about 9.5 per
 * type on each lane at 40 to 250 types; this rounds both up.
 */
const LOAD_LOCKS = { base: 120, perType: 20 } as const

/** How long a statement of production's on the role or its database waits for a lock. */
const ROLE_LOCK_TIMEOUT_MS = 2_000

/** How many times production ends the role's sessions and tries again after such a wait. */
const ROLE_LOCK_ATTEMPTS = 5

const LOCK_TIMEOUT = "55P03"

/** How long dropping a branch's database waits for a lock before it fails, to be tried again. */
const DROP_LOCK_TIMEOUT_MS = 5_000

/**
 * How long a login stays valid. `enforce` renews it while a worker holds the branch, so a branch
 * nobody holds any more cannot log in past it, even with a password its code kept.
 */
const LOGIN_LEASE_MS = 15 * 60_000

/** How often `enforce` measures the database and renews the login: both cost more than a look. */
const SLOW_CHECK_MS = 60_000

/** Past this share of its size limit, `enforce` measures the database every round. */
const SIZE_WATCH_SHARE = 0.8

/** What production's instance and user are, as `hostedBranchRequirement` judges them. */
export interface HostedBranchHostFacts {
  readonly user: string
  readonly superuser: boolean
  readonly createrole: boolean
  readonly createdb: boolean
  readonly version: number
  readonly database: string
  /** Whether every role may connect to production's database (`CONNECT` for `PUBLIC`). */
  readonly publicConnect: boolean
  readonly maxPreparedTransactions: number
  readonly maxConnections: number
  readonly maxLocksPerTransaction: number
  /** The object types a branch's copy loads, when known. */
  readonly objectTypes?: number
}

/**
 * What production lacks to host branches, as a phrase that follows "needs", or null. Every check
 * here stops a branch before it changes anything.
 */
export function hostedBranchRequirement(facts: HostedBranchHostFacts): string | null {
  if (facts.version < 160_000) return "PostgreSQL 16 or later"

  const missing = [
    ...(facts.superuser || facts.createrole ? [] : ["CREATEROLE"]),
    ...(facts.superuser || facts.createdb ? [] : ["CREATEDB"]),
  ]
  if (missing.length > 0) {
    return `production's database user '${facts.user}' to have ${missing.join(" and ")}, to give each branch a role and a database of its own on production's instance. As a superuser: ALTER ROLE "${facts.user}" ${missing.join(" ")}`
  }

  // A prepared transaction outlives its session, with its locks and the vacuum horizon it holds
  // back, and only its owner may finish it: a branch could leave one production cannot end.
  if (facts.maxPreparedTransactions > 0) {
    return `max_prepared_transactions = 0 on production's instance (it is ${facts.maxPreparedTransactions}): a transaction a branch prepared would outlive its session, with its locks, beyond production's reach. The framework never prepares one: set it to 0 and restart PostgreSQL`
  }

  if (facts.publicConnect) {
    return `production's database '${facts.database}' closed to PUBLIC: every role may connect to it today, a branch's role too, and hold production's advisory keys or read its statistics there. As a superuser: REVOKE CONNECT ON DATABASE "${facts.database}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${facts.database}" TO each role that connects to it`
  }

  if (facts.objectTypes !== undefined) {
    const peak = loadLocks(facts.objectTypes)
    const connections = facts.maxConnections + facts.maxPreparedTransactions
    const share = facts.maxLocksPerTransaction * connections * LOCK_TABLE_SHARES.branch
    if (peak > share) {
      const needed = Math.ceil(peak / LOCK_TABLE_SHARES.branch / connections / 64) * 64
      return `a larger lock table for a copy of ${facts.objectTypes} object types: its load holds about ${peak} locks, more than a branch's quarter of the table (${Math.floor(share)}). Set max_locks_per_transaction = ${needed} and restart PostgreSQL`
    }
  }
  return null
}

/** The most locks a copy of `objectTypes` types holds while it loads: `LOAD_LOCKS`. */
function loadLocks(objectTypes: number): number {
  return LOAD_LOCKS.base + LOAD_LOCKS.perType * objectTypes
}

/**
 * The role, and the database it owns, of a branch namespace: one name, at most 63 bytes, unique in
 * the cluster. Roles and databases are cluster-wide, so the hash covers production's database and
 * schema, which is the project: two projects' branches of the same name never share one.
 */
export function hostedBranchRoleName(input: {
  readonly database: string
  readonly productionSchema: string
  readonly namespace: string
}): string {
  assertBranchNamespaceName(input.namespace)

  const hash = createHash("sha256")
    .update(`${input.database}\u0000${input.productionSchema}\u0000${input.namespace}`)
    .digest("hex")
    .slice(0, HASH_LENGTH)
  const room = MAX_IDENTIFIER_BYTES - ROLE_PREFIX.length - HASH_LENGTH - 1
  const slug = input.namespace.replaceAll("-", "_").slice(0, room).replace(/_+$/, "")

  return `${ROLE_PREFIX}${slug}_${hash}`
}

/**
 * The SCRAM-SHA-256 verifier of `password`, computed here: the server stores it as given, and the
 * password itself never appears in a statement, so in no log either (RFC 5802, RFC 7677). The
 * passwords are random hex, which SASLprep leaves unchanged.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256")
  const clientKey = createHmac("sha256", salted).update("Client Key").digest()
  const storedKey = createHash("sha256").update(clientKey).digest()
  const serverKey = createHmac("sha256", salted).update("Server Key").digest()

  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`
}

/**
 * Where a branch's role logs in: production's own instance and TLS settings, as the role, on the
 * branch's database. A production configured by host and port gets its `ssl` setting as
 * `sslmode`, so the branch never connects in plain text where production would not.
 */
export function hostedBranchLoginUrl(
  production: HostedBranchConnection,
  login: { readonly user: string; readonly password: string; readonly database: string }
): string {
  const url = new URL(
    production.connectionString ??
      `postgres://${production.host ?? "localhost"}:${production.port ?? 5432}/`
  )
  url.username = encodeURIComponent(login.user)
  url.password = encodeURIComponent(login.password)
  url.pathname = `/${encodeURIComponent(login.database)}`

  const sslmode = sslModeOf(production.ssl)
  if (sslmode && !url.searchParams.has("sslmode")) url.searchParams.set("sslmode", sslmode)
  return url.toString()
}

/** porsager's `ssl` option as libpq's `sslmode`, which porsager reads back from a URL. */
function sslModeOf(ssl: HostedBranchConnection["ssl"]): string | null {
  if (ssl === true) return "verify-full"
  if (ssl === "require" || ssl === "prefer") return ssl
  return null
}

interface RoleSession {
  readonly pid: number
  readonly database: string | null
  readonly advisory: number
  readonly blocking: boolean
  readonly ended: boolean
  readonly long_statement: boolean
}

export class PgHostedBranches {
  /** When `enforce` last measured each branch's database, and how full it was, by role. */
  readonly #measured = new Map<string, { readonly at: number; readonly share: number }>()

  constructor(
    private readonly sql: SQL,
    private readonly input: {
      readonly productionSchema: string
      readonly connection: HostedBranchConnection
      /** Production's own login, one connection, on another database of its instance. */
      readonly connect: (database: string) => SQL
    }
  ) {}

  /**
   * What production lacks to host branches, or null when it lacks nothing: see
   * `hostedBranchRequirement`.
   */
  async unmetRequirement(objectTypes?: number): Promise<string | null> {
    const [row] = await this.sql<Omit<HostedBranchHostFacts, "objectTypes">[]>`
      SELECT rolname AS "user", rolsuper AS superuser, rolcreaterole AS createrole,
        rolcreatedb AS createdb, current_database() AS database,
        current_setting('server_version_num')::int AS version,
        has_database_privilege('public', current_database(), 'CONNECT') AS "publicConnect",
        current_setting('max_prepared_transactions')::int AS "maxPreparedTransactions",
        current_setting('max_connections')::int AS "maxConnections",
        current_setting('max_locks_per_transaction')::int AS "maxLocksPerTransaction"
      FROM pg_roles WHERE rolname = current_user
    `
    if (!row) return "a database user PostgreSQL knows"

    return hostedBranchRequirement({
      ...row,
      ...(objectTypes === undefined ? {} : { objectTypes }),
    })
  }

  /**
   * Creates the role, without a login, and its database, with production's extensions in it. The
   * branch's runtime migrates it, as the role. Refuses a namespace that has its role already:
   * drop it first.
   */
  async create(
    namespace: string,
    limits: HostedBranchLimits = {}
  ): Promise<{ readonly tempFileLimit: boolean }> {
    const name = await this.roleName(namespace)
    const ident = quoteIdent(name)
    const connectionLimit = positive(
      limits.connectionLimit ?? DEFAULT_LIMITS.connectionLimit,
      "connectionLimit"
    )
    const statementTimeout = positive(
      limits.statementTimeoutMillis ?? DEFAULT_LIMITS.statementTimeoutMillis,
      "statementTimeoutMillis"
    )
    const idleInTransaction = positive(
      limits.idleInTransactionMillis ?? DEFAULT_LIMITS.idleInTransactionMillis,
      "idleInTransactionMillis"
    )
    const tempFileKb = positive(
      limits.tempFileLimitKb ?? DEFAULT_LIMITS.tempFileLimitKb,
      "tempFileLimitKb"
    )

    const unmet = await this.unmetRequirement(limits.objectTypes)
    if (unmet) throw new Error(`[SixbPg] Hosted branches need ${unmet}.`)
    const extensions = await this.productionExtensions()

    const tempFileLimit = await this.bounded(async (tx) => {
      // No login until a runtime starts: `open` gives it one.
      await tx.unsafe(
        `CREATE ROLE ${ident} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE ` +
          `NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${connectionLimit}`
      )
      // Defaults the role could SET away: production enforces the time limits itself (`enforce`).
      await tx.unsafe(`ALTER ROLE ${ident} SET statement_timeout = ${statementTimeout}`)
      await tx.unsafe(
        `ALTER ROLE ${ident} SET idle_in_transaction_session_timeout = ${idleInTransaction}`
      )

      // A superuser's setting, which the role cannot raise: it caps what one session spills to
      // disk. A production that may not set it leaves it at the server's.
      const [settable] = await tx<{ settable: boolean }[]>`
        SELECT has_parameter_privilege('temp_file_limit', 'SET') AS settable
      `
      const capped = settable?.settable === true
      if (capped) await tx.unsafe(`ALTER ROLE ${ident} SET temp_file_limit = '${tempFileKb}kB'`)

      // Production acts on the role, to give it its database, end its sessions and drop it, which
      // takes holding the role's privileges. It acts in the role's database with them only to
      // create production's extensions there, before the role ever logs in.
      await tx.unsafe(`GRANT ${ident} TO CURRENT_USER`)
      return capped
    })

    try {
      await this.sql.unsafe(`CREATE DATABASE ${ident} OWNER ${ident}`)
      // Every role may connect to a new database: this one is its own role's alone.
      await this.sql.unsafe(`REVOKE ALL ON DATABASE ${ident} FROM PUBLIC`)
      await this.createExtensions(name, extensions)
    } catch (error) {
      await this.drop(namespace).catch(() => undefined)
      throw error
    }
    return { tempFileLimit }
  }

  /**
   * A login for one start of the branch's runtime: a new password, valid for a while `enforce`
   * renews. The sessions of an earlier start end, so only the new runtime's remain.
   */
  async open(namespace: string): Promise<HostedBranchLogin> {
    const role = await this.roleName(namespace)
    const password = newPassword()

    await this.alterRole(
      role,
      `LOGIN PASSWORD ${literal(scramVerifier(password))} VALID UNTIL ${literal(await this.leaseEnd())}`
    )
    await this.endSessions(role)

    return {
      url: hostedBranchLoginUrl(this.input.connection, { user: role, password, database: role }),
      schemaName: this.input.productionSchema,
    }
  }

  /**
   * Takes the role's login away and ends its sessions: the branch's runtime is stopped. Its
   * sessions end first, since one may hold the role's own row (an `ALTER ROLE` of its own left
   * open), then again, for any that logged in meanwhile.
   */
  async close(namespace: string): Promise<void> {
    const role = await this.roleName(namespace)
    this.#measured.delete(role)
    if (!(await this.roleExists(role))) return

    await this.endSessions(role)
    await this.alterRole(role, "NOLOGIN")
    await this.endSessions(role)
  }

  /**
   * Drops the branch: closes it, then drops its database with everything in it, then the role. A
   * database still locked after a while fails the drop, to be tried again, rather than queue
   * production's own work behind it.
   */
  async drop(namespace: string): Promise<void> {
    const role = await this.roleName(namespace)
    const ident = quoteIdent(role)
    await this.close(namespace)

    const [database] = await this.sql<{ template: boolean }[]>`
      SELECT datistemplate AS template FROM pg_database WHERE datname = ${role}
    `
    if (database) {
      // Its owner may make it a template, which PostgreSQL refuses to drop.
      if (database.template) {
        await this.bounded((tx) => tx.unsafe(`ALTER DATABASE ${ident} IS_TEMPLATE false`))
      }

      await withReservedPgConnection(this.sql, async (connection) => {
        await connection.unsafe(`SET lock_timeout = ${DROP_LOCK_TIMEOUT_MS}`)
        try {
          await connection.unsafe(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`)
        } finally {
          await connection.unsafe("RESET lock_timeout")
        }
      })
    }

    if (!(await this.roleExists(role))) return
    await this.dropOwnedElsewhere(role)
    // Its grants go with DROP OWNED.
    await this.bounded(async (tx) => {
      await tx.unsafe(`DROP OWNED BY ${ident}`)
      await tx.unsafe(`DROP ROLE ${ident}`)
    })
  }

  /**
   * Holds the role to its limits whatever it SETs. Cancels its statements past the statement
   * limit, and ends its sessions past the transaction limit or idle in a transaction past that
   * limit. Closes the branch when one of its sessions holds too many advisory locks, holds a lock
   * another role's session waits for, or is connected to another database, when it holds more
   * than its share of the lock table, and, measured once a
   * minute, when its database grows past its size limit. That minute it also renews the login of
   * a branch still open. A member of the role may signal its backends, which production is.
   */
  async enforce(
    namespace: string,
    limits: HostedBranchLimits = {}
  ): Promise<HostedBranchEnforcement> {
    const role = await this.roleName(namespace)
    const statement = limits.statementTimeoutMillis ?? DEFAULT_LIMITS.statementTimeoutMillis
    const transaction = limits.transactionTimeoutMillis ?? DEFAULT_LIMITS.transactionTimeoutMillis
    const idle = limits.idleInTransactionMillis ?? DEFAULT_LIMITS.idleInTransactionMillis
    const sizeLimitMb =
      limits.databaseSizeLimitMb === undefined
        ? undefined
        : positive(limits.databaseSizeLimitMb, "databaseSizeLimitMb")

    const sessions = await this.sql<RoleSession[]>`
      WITH locks AS (
        SELECT pid, count(*)::int AS advisory FROM pg_locks
        WHERE locktype = 'advisory' AND pid IS NOT NULL
        GROUP BY pid
      )
      SELECT a.pid, a.datname AS database, coalesce(l.advisory, 0) AS advisory,
        -- From pg_locks, which every user sees whole: pg_stat_activity hides another user's
        -- wait and backend type from a production that is no superuser. A user's session, not
        -- a background worker's, which has none.
        EXISTS (
          SELECT 1 FROM pg_locks w
          JOIN pg_stat_activity wa ON wa.pid = w.pid
          WHERE NOT w.granted AND wa.usename IS NOT NULL AND wa.usename <> ${role}
            AND a.pid = ANY (pg_blocking_pids(w.pid))
        ) AS blocking,
        (a.xact_start IS NOT NULL
          AND now() - a.xact_start > ${transaction} * interval '1 millisecond')
        OR (a.state LIKE 'idle in transaction%'
          AND now() - a.state_change > ${idle} * interval '1 millisecond') AS ended,
        (a.state = 'active'
          AND now() - a.query_start > ${statement} * interval '1 millisecond') AS long_statement
      FROM pg_stat_activity a
      LEFT JOIN locks l ON l.pid = a.pid
      WHERE a.usename = ${role} AND a.pid <> pg_backend_pid()
    `

    const closed =
      closureOf(role, sessions) ??
      (await this.lockTableClosure(role)) ??
      (await this.slowCheck(role, sizeLimitMb))
    if (closed) {
      await this.close(namespace)
      return { stopped: sessions.length, closed }
    }

    const ended = sessions.filter((session) => session.ended).map((session) => session.pid)
    const cancelled = sessions
      .filter((session) => !session.ended && session.long_statement)
      .map((session) => session.pid)
    if (ended.length + cancelled.length === 0) return { stopped: 0, closed: null }

    // By pid and role both: a pid ended meanwhile may be another session's by now.
    const stopped = await this.sql<{ stopped: boolean }[]>`
      SELECT CASE WHEN pid = ANY (${ended}::int[]) THEN pg_terminate_backend(pid)
        ELSE pg_cancel_backend(pid) END AS stopped
      FROM pg_stat_activity
      WHERE usename = ${role} AND pid = ANY (${[...ended, ...cancelled]}::int[])
    `
    return { stopped: stopped.filter((row) => row.stopped).length, closed: null }
  }

  /** The role of a branch namespace, which is also its database's name. */
  async roleName(namespace: string): Promise<string> {
    return hostedBranchRoleName({
      database: await this.database(),
      productionSchema: this.input.productionSchema,
      namespace,
    })
  }

  /** The branch's share of the lock table, and all branches' together: `LOCK_TABLE_SHARES`. */
  private async lockTableClosure(role: string): Promise<HostedBranchClosure | null> {
    const rows = await this.sql<{ role: string; locks: number; capacity: number }[]>`
      SELECT a.usename AS role, count(*)::int AS locks,
        current_setting('max_locks_per_transaction')::int * (
          current_setting('max_connections')::int
          + current_setting('max_prepared_transactions')::int
        ) AS capacity
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.fastpath AND a.usename LIKE ${`${ROLE_PREFIX.replaceAll("_", "\\_")}%`}
      GROUP BY a.usename
      ORDER BY locks DESC, a.usename
    `
    const own = rows.find((row) => row.role === role)
    if (!own) return null

    const capacity = own.capacity
    if (own.locks > capacity * LOCK_TABLE_SHARES.branch) {
      return { reason: "locks", locks: own.locks }
    }

    const all = rows.reduce((sum, row) => sum + row.locks, 0)
    if (all > capacity * LOCK_TABLE_SHARES.branches && rows[0]?.role === role) {
      return { reason: "crowded", locks: own.locks }
    }
    return null
  }

  /**
   * Once a minute per branch, at once for one this process has not looked at yet, and every
   * round once it is past `SIZE_WATCH_SHARE` of its limit: measures its database, and renews the
   * login of a branch still open.
   */
  private async slowCheck(
    role: string,
    sizeLimitMb: number | undefined
  ): Promise<HostedBranchClosure | null> {
    const now = Date.now()
    const last = this.#measured.get(role)
    if (last && now - last.at < SLOW_CHECK_MS && last.share < SIZE_WATCH_SHARE) return null

    const [row] = await this.sql<{ bytes: string; production: string; login: boolean }[]>`
      SELECT pg_database_size(d.oid)::text AS bytes,
        pg_database_size(current_database())::text AS production, r.rolcanlogin AS login
      FROM pg_database d
      JOIN pg_roles r ON r.rolname = d.datname
      WHERE d.datname = ${role}
    `
    if (!row) return null

    const bytes = Number(row.bytes)
    const limitBytes =
      sizeLimitMb === undefined
        ? Math.max(DEFAULT_LIMITS.databaseSizeLimitMb * 1024 * 1024, 2 * Number(row.production))
        : sizeLimitMb * 1024 * 1024
    this.#measured.set(role, { at: now, share: bytes / limitBytes })
    if (bytes > limitBytes) return { reason: "disk", bytes, limitBytes }

    if (row.login) await this.alterRole(role, `VALID UNTIL ${literal(await this.leaseEnd())}`)
    return null
  }

  /**
   * `ALTER ROLE` on the branch's role, bounded: a branch session holding the role's row ends, and
   * it runs again. Fails, to be tried again, when the role keeps it held.
   */
  private async alterRole(role: string, change: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.bounded((tx) => tx.unsafe(`ALTER ROLE ${quoteIdent(role)} ${change}`))
        return
      } catch (error) {
        if (pgErrorCode(error) !== LOCK_TIMEOUT) throw error
        if (attempt === ROLE_LOCK_ATTEMPTS) {
          throw new Error(
            `[SixbPg] Branch role '${role}' kept its own row locked through ${ROLE_LOCK_ATTEMPTS} attempts: production could not change it. Try again.`,
            { cause: error }
          )
        }
        await this.endSessions(role)
      }
    }
  }

  /** `run` in a transaction of its own, whose statements wait for a lock a bounded time. */
  private bounded<T>(run: (tx: SQLClient) => Promise<T>): Promise<T> {
    return runPgTransaction(this.sql, async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = ${ROLE_LOCK_TIMEOUT_MS}`)
      return run(tx)
    })
  }

  /**
   * What the role owns in the instance's other databases, such as a large object made where
   * `PUBLIC` may connect, which keeps `DROP ROLE` failing: dropped there, as production.
   */
  private async dropOwnedElsewhere(role: string): Promise<void> {
    const databases = await this.sql<{ name: string }[]>`
      SELECT DISTINCT d.datname AS name
      FROM pg_shdepend s
      JOIN pg_database d ON d.oid = s.dbid
      WHERE s.refclassid = 'pg_authid'::regclass
        AND s.refobjid = (SELECT oid FROM pg_roles WHERE rolname = ${role})
        AND d.datname <> current_database()
      ORDER BY 1
    `
    for (const { name } of databases) {
      const sql = this.input.connect(name)
      try {
        await runPgTransaction(sql, async (tx) => {
          await tx.unsafe(`SET LOCAL lock_timeout = ${ROLE_LOCK_TIMEOUT_MS}`)
          await tx.unsafe(`DROP OWNED BY ${quoteIdent(role)}`)
        })
      } catch (error) {
        throw new Error(
          `[SixbPg] Branch role '${role}' owns objects in database '${name}', which production could not drop: ${error instanceof Error ? error.message : String(error)}. As a superuser, in that database: DROP OWNED BY "${role}"`,
          { cause: error }
        )
      } finally {
        await sql.end({ timeout: 5 })
      }
    }
  }

  /** The extensions production's storage uses that production's own database has. */
  private async productionExtensions(): Promise<readonly string[]> {
    const rows = await this.sql<{ name: string }[]>`
      SELECT e.extname AS name FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE n.nspname = 'public' AND e.extname = ANY (${[...EXTENSIONS]}::text[])
      ORDER BY e.extname
    `
    return rows.map((row) => row.name)
  }

  /** Production's extensions in the branch's database, created as production before handover. */
  private async createExtensions(database: string, extensions: readonly string[]): Promise<void> {
    if (extensions.length === 0) return

    const sql = this.input.connect(database)
    try {
      for (const extension of extensions) {
        await sql
          .unsafe(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension)} WITH SCHEMA public`)
          .catch((error: unknown) => {
            throw new Error(
              `[SixbPg] Production could not create extension '${extension}' in a branch's database: ${error instanceof Error ? error.message : String(error)}. Production's own database has it, and the branch's role may not create it: give production's database user the right to.`,
              { cause: error }
            )
          })
      }
    } finally {
      await sql.end({ timeout: 5 })
    }
  }

  private async endSessions(role: string): Promise<void> {
    await this.sql`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE usename = ${role} AND pid <> pg_backend_pid()
    `
  }

  private async roleExists(role: string): Promise<boolean> {
    const [row] = await this.sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`
    return row !== undefined
  }

  /** When a login given or renewed now runs out, by the server's clock. */
  private async leaseEnd(): Promise<string> {
    const [row] = await this.sql<{ until: string }[]>`
      SELECT (now() + ${LOGIN_LEASE_MS} * interval '1 millisecond')::text AS until
    `
    if (!row) throw new Error("[SixbPg] PostgreSQL gave no time.")
    return row.until
  }

  private async database(): Promise<string> {
    const [row] = await this.sql<{ name: string }[]>`SELECT current_database() AS name`
    if (!row) throw new Error("[SixbPg] PostgreSQL named no current database.")
    return row.name
  }
}

/** Why the role's sessions close the branch, or null. */
function closureOf(database: string, sessions: readonly RoleSession[]): HostedBranchClosure | null {
  for (const session of sessions) {
    if (session.advisory > ADVISORY_LOCKS_PER_SESSION) {
      return { reason: "locks", locks: session.advisory }
    }
    if (session.blocking) return { reason: "blocking" }
    if (session.database !== null && session.database !== database) {
      return { reason: "elsewhere", database: session.database }
    }
  }
  return null
}

function newPassword(): string {
  return randomBytes(32).toString("hex")
}

/** A verifier is base64 and a time is digits and signs: none needs more than doubled quotes. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`[SixbPg] A hosted branch's ${name} must be a positive integer.`)
  }
  return value
}
