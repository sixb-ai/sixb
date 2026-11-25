import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto"
import { assertBranchNamespaceName } from "@sixb/core/internal/storage"
import { quoteIdent } from "./migrations"
import type { SQL } from "./pg-client"

/**
 * A hosted branch's home on production's instance: a schema the branch's own role owns, and the
 * role, limited to it. `packages/core/src/branches/README.md`, "Production's instance", says what
 * holds and why.
 *
 * Production creates the role and the empty schema, and nothing more: the branch's runtime
 * migrates it and loads its copy, as the role. Production never runs its own migrations or DDL
 * there, so nothing the branch plants in its schema ever runs with production's privileges. All it
 * does there afterwards is drop it, with `DROP SCHEMA … CASCADE` and `DROP ROLE`.
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
}

/** How production connects, which a branch's login copies but for its user and password. */
export interface HostedBranchConnection {
  readonly connectionString?: string
  readonly host?: string
  readonly port?: number
  readonly database?: string
  readonly ssl?: boolean | "require" | "prefer"
}

export interface HostedBranchLogin {
  /** Production's instance and database, as the role. */
  readonly url: string
  readonly schemaName: string
}

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
} as const

/**
 * An advisory lock a branch must never hold: the database's own, which every schema shares. The
 * framework namespaces every other key by schema (`lockAdvisoryKeys`), so a branch's own locks
 * never meet production's.
 */
export type ProductionLock =
  /** A two-key lock, such as a migration's. */
  | { readonly pair: readonly [number, number] }
  /** A one-key lock on `hashtextextended(text, 0)`, such as an extension's creation. */
  | { readonly text: string }

/** How long dropping a branch's schema waits for a lock before it fails, to be tried again. */
const DROP_LOCK_TIMEOUT_MS = 5_000

/**
 * The role, and the schema it owns, of a branch namespace: one name, at most 63 bytes, unique in
 * the cluster. Roles are cluster-wide, so the hash covers the database and production's schema,
 * which is the project: two projects' branches of the same name never share a role.
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
 * Where a branch's role logs in: production's own instance, database and TLS settings, as the
 * role. A production configured by host and port gets its `ssl` setting as `sslmode`, so the
 * branch never connects in plain text where production would not.
 */
export function hostedBranchLoginUrl(
  production: HostedBranchConnection,
  login: { readonly user: string; readonly password: string }
): string {
  const url = new URL(
    production.connectionString ??
      `postgres://${production.host ?? "localhost"}:${production.port ?? 5432}/${encodeURIComponent(production.database ?? "")}`
  )
  url.username = encodeURIComponent(login.user)
  url.password = encodeURIComponent(login.password)

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

export class PgHostedBranches {
  constructor(
    private readonly sql: SQL,
    private readonly input: {
      readonly productionSchema: string
      readonly connection: HostedBranchConnection
      /**
       * The database-wide advisory locks a branch must never hold, such as production's
       * migrations': a branch holding one would stop production's deploys.
       */
      readonly productionLocks: readonly ProductionLock[]
    }
  ) {}

  /**
   * Creates the role, and the empty schema it owns. The branch's runtime migrates it, as the
   * role. Refuses a namespace that has its role already: drop it first.
   */
  async create(
    namespace: string,
    limits: HostedBranchLimits = {}
  ): Promise<{ readonly tempFileLimit: boolean }> {
    const role = await this.roleName(namespace)
    const ident = quoteIdent(role)
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
    const database = await this.database()

    return this.sql.begin(async (tx) => {
      // No password until a runtime starts: `open` gives it one.
      await tx.unsafe(
        `CREATE ROLE ${ident} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ` +
          `NOBYPASSRLS CONNECTION LIMIT ${connectionLimit}`
      )
      // Defaults the role could SET away: production enforces the time limits itself (`enforce`).
      await tx.unsafe(`ALTER ROLE ${ident} SET statement_timeout = ${statementTimeout}`)
      await tx.unsafe(
        `ALTER ROLE ${ident} SET idle_in_transaction_session_timeout = ${idleInTransaction}`
      )
      await tx.unsafe(`ALTER ROLE ${ident} SET search_path = ${ident}`)
      // A superuser's setting, which the role cannot raise: it caps what one session spills to
      // disk. A production that may not set it leaves it at the server's.
      const [settable] = await tx<{ settable: boolean }[]>`
        SELECT has_parameter_privilege('temp_file_limit', 'SET') AS settable
      `
      const tempFileLimit = settable?.settable === true
      if (tempFileLimit) {
        await tx.unsafe(`ALTER ROLE ${ident} SET temp_file_limit = '${tempFileKb}kB'`)
      }
      await tx.unsafe(`GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${ident}`)
      // Production acts on the role, to give it its schema, cancel its statements and drop it,
      // which takes holding the role's privileges. It never acts in the role's schema with them.
      await tx.unsafe(`GRANT ${ident} TO CURRENT_USER`)
      await tx.unsafe(`CREATE SCHEMA ${ident} AUTHORIZATION ${ident}`)
      return { tempFileLimit }
    })
  }

  /** A new password for the role, for one start of the branch's runtime. */
  async open(namespace: string): Promise<HostedBranchLogin> {
    const role = await this.roleName(namespace)
    const password = newPassword()

    await this.sql.unsafe(
      `ALTER ROLE ${quoteIdent(role)} PASSWORD ${literal(scramVerifier(password))}`
    )
    return this.login(role, password)
  }

  /**
   * Drops the branch: the role logs in no more, its sessions end, then its schema goes with
   * everything in it, then the role. A schema still locked after a while fails the drop, to be
   * tried again, rather than queue production's own work behind it.
   */
  async drop(namespace: string): Promise<void> {
    const role = await this.roleName(namespace)
    const ident = quoteIdent(role)
    const [exists] = await this.sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`

    if (exists) {
      // First, so a runtime still running cannot open a new session between the next two steps.
      await this.sql.unsafe(`ALTER ROLE ${ident} NOLOGIN`)
      await this.sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${role}`
    }

    await this.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = ${DROP_LOCK_TIMEOUT_MS}`)
      await tx.unsafe(`DROP SCHEMA IF EXISTS ${ident} CASCADE`)
    })
    if (!exists) return

    // Its grant on the database goes with DROP OWNED.
    await this.sql.begin(async (tx) => {
      await tx.unsafe(`DROP OWNED BY ${ident}`)
      await tx.unsafe(`DROP ROLE ${ident}`)
    })
  }

  /**
   * Holds the role to its limits whatever it SETs: cancels its statements past the statement
   * limit, and ends its sessions past the transaction limit, idle in a transaction past that
   * limit, or holding one of the database-wide advisory locks production takes. Returns how many
   * it stopped. A member of the role may signal its backends, which production is.
   */
  async enforce(namespace: string, limits: HostedBranchLimits = {}): Promise<number> {
    const role = await this.roleName(namespace)
    const statement = limits.statementTimeoutMillis ?? DEFAULT_LIMITS.statementTimeoutMillis
    const transaction = limits.transactionTimeoutMillis ?? DEFAULT_LIMITS.transactionTimeoutMillis
    const idle = limits.idleInTransactionMillis ?? DEFAULT_LIMITS.idleInTransactionMillis
    const locks = this.input.productionLocks
    // pg_locks shows a two-key lock's keys as unsigned oids, a one-key lock's as its halves.
    const pairs = JSON.stringify(
      locks.flatMap((lock) => ("pair" in lock ? [[lock.pair[0] >>> 0, lock.pair[1] >>> 0]] : []))
    )
    const texts = locks.flatMap((lock) => ("text" in lock ? [lock.text] : []))

    const rows = await this.sql<{ stopped: boolean }[]>`
      WITH sessions AS (
        SELECT a.pid,
          (a.xact_start IS NOT NULL
            AND now() - a.xact_start > ${transaction} * interval '1 millisecond')
          OR (a.state LIKE 'idle in transaction%'
            AND now() - a.state_change > ${idle} * interval '1 millisecond') AS ended,
          EXISTS (
            SELECT 1 FROM pg_locks l
            WHERE l.pid = a.pid AND l.locktype = 'advisory' AND (
              (l.objsubid = 2 AND jsonb_build_array(l.classid::bigint, l.objid::bigint)
                IN (SELECT value FROM jsonb_array_elements(${pairs}::text::jsonb)))
              OR (l.objsubid = 1 AND ((l.classid::bigint << 32) | l.objid::bigint)
                IN (SELECT hashtextextended(key, 0) FROM unnest(${texts}::text[]) AS keys(key)))
            )
          ) AS production_lock,
          (a.state = 'active'
            AND now() - a.query_start > ${statement} * interval '1 millisecond') AS long_statement
        FROM pg_stat_activity a
        WHERE a.usename = ${role} AND a.pid <> pg_backend_pid()
      )
      SELECT CASE
        WHEN ended OR production_lock THEN pg_terminate_backend(pid)
        ELSE pg_cancel_backend(pid)
      END AS stopped
      FROM sessions
      WHERE ended OR production_lock OR long_statement
    `
    return rows.filter((row) => row.stopped).length
  }

  async roleName(namespace: string): Promise<string> {
    return hostedBranchRoleName({
      database: await this.database(),
      productionSchema: this.input.productionSchema,
      namespace,
    })
  }

  private login(role: string, password: string): HostedBranchLogin {
    return {
      url: hostedBranchLoginUrl(this.input.connection, { user: role, password }),
      schemaName: role,
    }
  }

  private async database(): Promise<string> {
    const [row] = await this.sql<{ name: string }[]>`SELECT current_database() AS name`
    if (!row) throw new Error("[SixbPg] PostgreSQL named no current database.")
    return row.name
  }
}

function newPassword(): string {
  return randomBytes(32).toString("hex")
}

/** A verifier is base64 and fixed text: nothing in it needs more than doubling a quote. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`[SixbPg] A hosted branch's ${name} must be a positive integer.`)
  }
  return value
}
