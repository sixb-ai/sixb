import { isIP } from "node:net"
import { connect as connectTls, type TLSSocket } from "node:tls"
import postgres from "postgres"
import { pgErrorCode } from "./storage-errors"

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

/** One pool connection held outside the pool until `release()` — see `withReservedPgConnection`. */
export type ReservedSQL = postgres.ReservedSql<Record<string, never>>

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
    ...tlsOptions(options),
  }

  if (options.connectionString) {
    return assertDirectTlsTarget(postgres(options.connectionString, base), base)
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

/**
 * What the server's certificate is checked against when TLS is opened directly: nothing
 * (`require`), the trusted CAs (`verify-ca`), or the CAs and the host name (`verify-full`).
 */
type DirectTlsVerification = "none" | "ca" | "full"

// `sslnegotiation=direct` is read from the connection string, as libpq reads it. Without it,
// porsager negotiates TLS the classic way: an SSLRequest on a plain TCP socket, then an upgrade of
// that socket with `tls.connect({ socket })`. Bun 1.4.0–1.4.2 keeps every byte received on such an
// upgraded socket in memory for good, so a process that reads a lot grows until it is killed.
// Opening the TLS connection ourselves with `tls.connect({ host, port })` avoids that path, and
// saves the SSLRequest round trip on every connection.
function tlsOptions(options: CreatePgClientOptions): Record<string, unknown> {
  const verification = directTlsVerification(options)
  if (verification === null) {
    return options.ssl ? { ssl: options.ssl } : {}
  }
  // porsager must not negotiate TLS again on the socket we hand it; explicit options also
  // override the `sslmode` it would otherwise read from the connection string.
  return { ssl: false, sslnegotiation: null, socket: directTlsSocket(verification) }
}

function directTlsVerification(options: CreatePgClientOptions): DirectTlsVerification | null {
  const params = connectionStringParams(options.connectionString)
  if (params.get("sslnegotiation") !== "direct") {
    return null
  }

  const sslmode =
    options.ssl === true
      ? "verify-full"
      : options.ssl ||
        (params.get("sslrootcert") === "system"
          ? "verify-full"
          : (params.get("sslmode") ?? params.get("ssl")))
  switch (sslmode) {
    case "require":
      return "none"
    case "verify-ca":
      return "ca"
    case "verify-full":
    case "true":
      return "full"
    default:
      throw new Error(
        `[SixbPg] sslnegotiation=direct requires sslmode=require, verify-ca or verify-full, got ${
          sslmode ? `"${sslmode}"` : "no sslmode"
        }: a direct TLS connection has no plaintext fallback.`
      )
  }
}

function connectionStringParams(connectionString: string | undefined): URLSearchParams {
  return new URLSearchParams(connectionString?.split("?")[1] ?? "")
}

/**
 * porsager's `socket` factory, called for every connection. It must return at once and never
 * throw: a factory that fails leaves its pool slot stuck in porsager's connecting state for good,
 * and one that returns an already-dead socket stalls the slot's next attempt (postgres.js 3.4.9).
 * Failures are reported by the socket instead, through the `error` and `close` events porsager
 * handles for its own sockets, and its connect timeout covers the handshake.
 */
function directTlsSocket(
  verification: DirectTlsVerification
): (options: postgres.ParsedOptions) => TLSSocket {
  let reportedRefusal = false

  return ({ host: [host = "localhost"], port: [port = 5432] }) => {
    const socket = connectTls({
      host,
      port,
      servername: isIP(host) ? undefined : host,
      // PostgreSQL 17+ accepts a direct TLS connection only for this ALPN protocol.
      ALPNProtocols: ["postgresql"],
      rejectUnauthorized: verification !== "none",
      ...(verification === "ca" ? { checkServerIdentity: () => undefined } : {}),
    })

    let reachedServer = false
    let secured = false
    socket.once("connect", () => {
      reachedServer = true
    })
    socket.once("secureConnect", () => {
      secured = true
      if (socket.alpnProtocol !== "postgresql") {
        socket.destroy(
          new Error(
            `[SixbPg] ${host}:${port} accepted TLS without selecting the "postgresql" protocol` +
              " (ALPN), so it is not a PostgreSQL server accepting sslnegotiation=direct."
          )
        )
      }
    })
    // A server that expects an SSLRequest reads the TLS hello as a malformed startup packet and
    // closes the connection, which porsager reports as a bare reset. Say what it means, once.
    socket.once("error", (error: Error) => {
      if (reportedRefusal || !reachedServer || secured) return
      if (!["ECONNRESET", "EPIPE", "ERR_SOCKET_CLOSED"].includes(pgErrorCode(error) ?? "")) return
      reportedRefusal = true
      console.error(
        `[SixbPg] ${host}:${port} closed the connection during a direct TLS handshake` +
          " (sslnegotiation=direct). Direct TLS needs PostgreSQL 17 or later, reached without a" +
          " proxy or pooler that expects an SSLRequest; remove sslnegotiation=direct otherwise."
      )
    })
    return socket
  }
}

function assertDirectTlsTarget(sql: SQL, options: Record<string, unknown>): SQL {
  if (!("socket" in options)) {
    return sql
  }
  if (sql.options.host.length !== 1 || sql.options.path) {
    throw new Error(
      "[SixbPg] sslnegotiation=direct supports one TCP host:port in the connection string, not" +
        " several hosts or a Unix socket path."
    )
  }
  return sql
}
