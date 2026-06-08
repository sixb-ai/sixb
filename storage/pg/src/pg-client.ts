import postgres from "postgres"

// Data-type policy (porsager defaults, deliberately not overridden):
// - `timestamptz` -> JS `Date`. Row mappers normalize via `toIsoString(Date | string)`.
// - `bigint` -> string (porsager avoids `Number` precision loss). The only bigint values
//   read here are `COUNT(*)` results, which fit safely in `Number`, so callers use
//   `Number(...)`. We do NOT register `postgres.BigInt` — it would break those `Number()`
//   conversions and JSON serialization.
// - `numeric`/`decimal` -> string. The schema has no such columns; revisit if one is added.
// - `jsonb` -> parsed JS value (objects/arrays/scalars), same as before.

/**
 * Connection handle backing every Postgres storage adapter.
 *
 * This is the porsager `postgres` pool — not Bun's built-in SQL. bun:sql's pool orphaned
 * connections under request bursts (a query whose client disconnected mid-flight left its
 * connection checked out but never returned), so the pool drained to zero usable slots and
 * the whole API hung until a restart. porsager's pool reclaims connections reliably, which
 * is the actual fix for that wedge.
 *
 * Queries declare their row type per call (`` sql<RowType[]>`...` ``) rather than via an open
 * generic, so results are typed without `as` casts.
 */
export type SQL = postgres.Sql<Record<string, never>>

/**
 * A query runner that may be the pool or an open transaction. Adapters that run the same
 * statement on either should accept this rather than {@link SQL} (only the pool exposes
 * `begin`/`reserve`/`end`).
 */
export type SQLClient = postgres.ISql<Record<string, never>>

/**
 * A value accepted as a positional parameter by {@link SQLClient.unsafe}. Dynamically built
 * parameter arrays (from the query-IR compiler / run-list helpers) are cast to this since
 * their element types can't be inferred statically.
 */
export type SqlParameter = postgres.ParameterOrJSON<never>

export interface CreatePgClientOptions {
  readonly connectionString?: string
  readonly host?: string
  readonly port?: number
  readonly database?: string
  readonly user?: string
  readonly password?: string
  /** Maximum pooled connections. */
  readonly max: number
  /** Schema pinned via `search_path` on every connection. */
  readonly schemaName: string
  /** Close idle connections after this many ms (frees slots back to the server). Default 30s. */
  readonly idleTimeoutMillis?: number
  /** Per-connection `statement_timeout` (ms). Unset = no timeout. */
  readonly statementTimeoutMillis?: number
  /** Per-connection `idle_in_transaction_session_timeout` (ms). Unset = no timeout. */
  readonly idleInTransactionSessionTimeoutMillis?: number
  /** Seconds to wait when establishing a connection. Default 10. */
  readonly connectTimeoutMillis?: number
  /**
   * Whether porsager creates server-side prepared statements (its default; faster against a
   * direct Postgres connection). Keep `true` for a direct connection. Behind a transaction-mode
   * pooler, prepared statements are supported by PgBouncer >= 1.21 (Oct 2023) when
   * `max_prepared_statements > 0`; set `false` only for an older PgBouncer or when that setting
   * is 0. (The blanket incompatibility in porsager#93 predates PgBouncer 1.21.)
   */
  readonly prepare?: boolean
  readonly ssl?: boolean | "require" | "prefer"
}

const DEFAULT_IDLE_TIMEOUT_SECONDS = 30
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10

/** Build a configured porsager `postgres` pool. */
export function createPgClient(options: CreatePgClientOptions): SQL {
  // GUCs applied to every connection at startup.
  const connection: Record<string, string | number | boolean> = {
    search_path: options.schemaName,
  }
  if (options.statementTimeoutMillis !== undefined) {
    connection.statement_timeout = options.statementTimeoutMillis
  }
  if (options.idleInTransactionSessionTimeoutMillis !== undefined) {
    connection.idle_in_transaction_session_timeout = options.idleInTransactionSessionTimeoutMillis
  }

  const idleTimeout =
    options.idleTimeoutMillis !== undefined
      ? Math.max(1, Math.round(options.idleTimeoutMillis / 1000))
      : DEFAULT_IDLE_TIMEOUT_SECONDS

  const connectTimeout =
    options.connectTimeoutMillis !== undefined
      ? Math.max(1, Math.round(options.connectTimeoutMillis / 1000))
      : DEFAULT_CONNECT_TIMEOUT_SECONDS

  const base = {
    max: options.max,
    // `idle_timeout` is important on managed Postgres (e.g. DigitalOcean), which closes idle
    // server-side connections — without it porsager can hand out a dead socket (porsager#179).
    idle_timeout: idleTimeout,
    connect_timeout: connectTimeout,
    // `max_lifetime` is intentionally left at porsager's default (a random 45–90 min): it
    // cycles connections to avoid server-side memory bloat from long-lived prepared
    // statements and plays nicely with managed databases. Disabling it is discouraged.
    connection,
    // Match the previous (bun:sql) behavior of not surfacing routine PostgreSQL NOTICEs.
    onnotice: () => {},
    ...(options.prepare !== undefined ? { prepare: options.prepare } : {}),
    ...(options.ssl ? { ssl: options.ssl } : {}),
  }

  if (options.connectionString) {
    return postgres(options.connectionString, base)
  }

  return postgres({
    ...base,
    host: options.host ?? "localhost",
    port: options.port ?? 5432,
    ...(options.database !== undefined ? { database: options.database } : {}),
    ...(options.user !== undefined ? { username: options.user } : {}),
    ...(options.password !== undefined ? { password: options.password } : {}),
  })
}
