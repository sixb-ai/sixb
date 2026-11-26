import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto"
import { assertBranchNamespaceName } from "@sixb/core/internal/storage"
import { quoteIdent } from "./migrations"
import type { SQL } from "./pg-client"
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
 * login away, and drops the database, `DROP DATABASE … WITH (FORCE)`, then the role.
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
   * to 20 GiB. Past it, production takes the role's login away.
   */
  readonly databaseSizeLimitMb?: number
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
  /** A session held more advisory locks than the framework ever takes. */
  | { readonly reason: "locks"; readonly locks: number }
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

/** How long dropping a branch's database waits for a lock before it fails, to be tried again. */
const DROP_LOCK_TIMEOUT_MS = 5_000

/**
 * How long a login stays valid. `enforce` renews it while a worker holds the branch, so a branch
 * nobody holds any more cannot log in past it, even with a password its code kept.
 */
const LOGIN_LEASE_MS = 15 * 60_000

/** How often `enforce` measures the database and renews the login: both cost more than a look. */
const SLOW_CHECK_MS = 60_000

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
  /** When `enforce` last measured each branch's database, by role. */
  readonly #measuredAt = new Map<string, number>()

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
   * What production's database user lacks to host branches, or null when it lacks nothing: each
   * branch gets a role and a database of its own.
   */
  async unmetRequirement(): Promise<string | null> {
    const [row] = await this.sql<
      {
        name: string
        superuser: boolean
        createrole: boolean
        createdb: boolean
        version: number
      }[]
    >`
      SELECT rolname AS name, rolsuper AS superuser, rolcreaterole AS createrole,
        rolcreatedb AS createdb, current_setting('server_version_num')::int AS version
      FROM pg_roles WHERE rolname = current_user
    `
    if (!row) return "a database user PostgreSQL knows"
    if (row.version < 160_000) return "PostgreSQL 16 or later"

    const missing = [
      ...(row.superuser || row.createrole ? [] : ["CREATEROLE"]),
      ...(row.superuser || row.createdb ? [] : ["CREATEDB"]),
    ]
    if (missing.length === 0) return null

    return `production's database user '${row.name}' to have ${missing.join(" and ")}, to give each branch a role and a database of its own on production's instance. As a superuser: ALTER ROLE "${row.name}" ${missing.join(" ")}`
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

    const unmet = await this.unmetRequirement()
    if (unmet) throw new Error(`[SixbPg] Hosted branches need ${unmet}.`)
    const extensions = await this.productionExtensions()

    const tempFileLimit = await runPgTransaction(this.sql, async (tx) => {
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

    await this.sql.unsafe(
      `ALTER ROLE ${quoteIdent(role)} LOGIN PASSWORD ${literal(scramVerifier(password))} ` +
        `VALID UNTIL ${literal(await this.leaseEnd())}`
    )
    await this.endSessions(role)

    return {
      url: hostedBranchLoginUrl(this.input.connection, { user: role, password, database: role }),
      schemaName: this.input.productionSchema,
    }
  }

  /** Takes the role's login away and ends its sessions: the branch's runtime is stopped. */
  async close(namespace: string): Promise<void> {
    const role = await this.roleName(namespace)
    if (!(await this.roleExists(role))) return

    // First, so a runtime still running cannot open a new session once the others end.
    await this.sql.unsafe(`ALTER ROLE ${quoteIdent(role)} NOLOGIN`)
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
      if (database.template) await this.sql.unsafe(`ALTER DATABASE ${ident} IS_TEMPLATE false`)

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
    // Its grants go with DROP OWNED.
    await runPgTransaction(this.sql, async (tx) => {
      await tx.unsafe(`DROP OWNED BY ${ident}`)
      await tx.unsafe(`DROP ROLE ${ident}`)
    })
  }

  /**
   * Holds the role to its limits whatever it SETs. Cancels its statements past the statement
   * limit, and ends its sessions past the transaction limit or idle in a transaction past that
   * limit. Closes the branch when one of its sessions holds too many advisory locks, holds a lock
   * another role's session waits for, or is connected to another database, and, measured once a
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
    const sizeLimitMb = positive(
      limits.databaseSizeLimitMb ?? DEFAULT_LIMITS.databaseSizeLimitMb,
      "databaseSizeLimitMb"
    )

    const sessions = await this.sql<RoleSession[]>`
      WITH locks AS (
        SELECT pid, count(*)::int AS advisory FROM pg_locks
        WHERE locktype = 'advisory' AND pid IS NOT NULL
        GROUP BY pid
      )
      SELECT a.pid, a.datname AS database, coalesce(l.advisory, 0) AS advisory,
        EXISTS (
          SELECT 1 FROM pg_stat_activity w
          WHERE w.wait_event_type = 'Lock' AND w.backend_type = 'client backend'
            AND w.usename IS DISTINCT FROM ${role} AND a.pid = ANY (pg_blocking_pids(w.pid))
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

    const closed = closureOf(role, sessions) ?? (await this.slowCheck(role, sizeLimitMb))
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

  /**
   * Once a minute per branch, at once for one this process has not looked at yet: measures its
   * database, and renews the login of a branch still open.
   */
  private async slowCheck(role: string, sizeLimitMb: number): Promise<HostedBranchClosure | null> {
    const now = Date.now()
    if (now - (this.#measuredAt.get(role) ?? Number.NEGATIVE_INFINITY) < SLOW_CHECK_MS) return null
    this.#measuredAt.set(role, now)

    const [row] = await this.sql<{ bytes: string; login: boolean }[]>`
      SELECT pg_database_size(d.oid)::text AS bytes, r.rolcanlogin AS login
      FROM pg_database d
      JOIN pg_roles r ON r.rolname = d.datname
      WHERE d.datname = ${role}
    `
    if (!row) return null

    const bytes = Number(row.bytes)
    const limitBytes = sizeLimitMb * 1024 * 1024
    if (bytes > limitBytes) return { reason: "disk", bytes, limitBytes }

    if (row.login) {
      await this.sql.unsafe(
        `ALTER ROLE ${quoteIdent(role)} VALID UNTIL ${literal(await this.leaseEnd())}`
      )
    }
    return null
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
