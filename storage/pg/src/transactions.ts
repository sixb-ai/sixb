import { createHash } from "node:crypto"
import type { ReservedSQL, SQL, SQLClient } from "./pg-client"
import { explainPgError, isConnectionLost } from "./storage-errors"

// Why transactions are driven here instead of through porsager's `sql.begin`:
//
// postgres.js 3.4.9 writes to a connection without checking that its socket is still open. When
// the server or the network drops a connection during a transaction, `sql.begin` answers the
// failed statement by sending ROLLBACK on it; the write is deferred to `setImmediate` and throws
// `null is not an object (evaluating 'socket.write')` there, outside any promise, which kills the
// process. `reserve().release()` has the matching flaw: it hands the connection back to the pool
// without looking at it, and the next query sent on it crashes the same way.
//
// Holding a reserved connection and sending BEGIN/COMMIT/ROLLBACK ourselves lets us act on the
// loss first. PostgreSQL has already rolled the transaction back and ended the session, so nothing
// more is sent on that connection and it is never released: the pool reconnects a closed
// connection on its own. The upstream fix is porsager/postgres#1209; until a release carries it,
// a connection that drops *between* two statements still crashes, because nothing reports the loss
// before the next statement's deferred write.

export type PgStoreClient = SQL | SQLClient

export interface RunPgTransactionOptions {
  /** Open the transaction at an explicit isolation; omit for the server default. */
  readonly isolation?: "repeatableRead" | "serializable"
}

type PgTransactionIsolation = "unverifiedDefault" | "repeatableRead" | "serializable"

// The isolation level is folded into `BEGIN` rather than a separate `SET TRANSACTION`: one
// round-trip instead of two, and the level takes effect before any statement of the transaction.
const BEGIN_STATEMENTS: Readonly<Record<PgTransactionIsolation, string>> = {
  unverifiedDefault: "BEGIN",
  repeatableRead: "BEGIN ISOLATION LEVEL REPEATABLE READ",
  serializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
}

/** Every client handed to a transaction callback; a reserved connection can never start one. */
const pgTransactionClients = new WeakSet<PgStoreClient>()
const activePgTransactions = new WeakMap<PgStoreClient, PgTransactionIsolation>()

export async function runPgTransaction<T>(
  sql: PgStoreClient,
  run: (tx: SQLClient) => Promise<T>,
  options: RunPgTransactionOptions = {}
): Promise<T> {
  if (!canStartPgTransaction(sql)) {
    return run(sql)
  }

  const isolation = options.isolation ?? "unverifiedDefault"
  try {
    return await withReservedPgConnection(sql, (tx) => {
      pgTransactionClients.add(tx)
      return runPgTransactionOn(
        tx,
        async () => {
          activePgTransactions.set(tx, isolation)
          try {
            return await run(tx)
          } finally {
            activePgTransactions.delete(tx)
          }
        },
        isolation
      )
    })
  } catch (error) {
    throw explainPgError(error)
  }
}

/**
 * Hold one pool connection for `run`, or reuse a caller-owned reserved connection.
 * Hand an owned connection back to the pool only while it is still usable.
 * A connection whose session is gone stays out of the pool, which replaces it on its own.
 */
export async function withReservedPgConnection<T>(
  sql: SQL | ReservedSQL,
  run: (connection: ReservedSQL) => Promise<T>
): Promise<T> {
  if (!("reserve" in sql)) return run(sql)
  const connection = await sql.reserve()
  let usable = true
  try {
    return await run(connection)
  } catch (error) {
    usable = !isConnectionLost(error)
    throw error
  } finally {
    if (usable) {
      connection.release()
    }
  }
}

/**
 * Run `run` inside one transaction on a reserved connection.
 *
 * PostgreSQL answers COMMIT with a `ROLLBACK` tag, not an error, when a statement of the
 * transaction failed and the callback caught that error and carried on. That outcome is surfaced
 * as an error: returning normally would report writes that were discarded.
 */
export async function runPgTransactionOn<T>(
  connection: ReservedSQL,
  run: () => Promise<T>,
  isolation: PgTransactionIsolation = "unverifiedDefault"
): Promise<T> {
  await connection.unsafe(BEGIN_STATEMENTS[isolation])
  const result = await undoOnFailure(run, () => connection.unsafe("ROLLBACK"))
  const commit = await connection.unsafe("COMMIT")
  if (commit.command !== "COMMIT") {
    throw new Error(
      "[SixbPg] PostgreSQL rolled the transaction back instead of committing it: a statement in it" +
        " failed and its error was caught without being rethrown. A failed statement aborts the" +
        " whole transaction, so let its error propagate out of the transaction callback."
    )
  }
  return result
}

/**
 * Run `run`; when it throws, first undo the session state it left on its connection (an open
 * transaction, a session lock), then rethrow. Nothing is undone when the connection itself was lost:
 * the server has already discarded that state, and anything more sent on it would crash
 * postgres.js (see the top of this file).
 */
export async function undoOnFailure<T>(
  run: () => Promise<T>,
  undo: () => Promise<unknown>
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!isConnectionLost(error)) {
      await undo()
    }
    throw error
  }
}

/**
 * Run a multi-statement read against one proven PostgreSQL snapshot.
 *
 * A provider-owned repeatable-read or serializable transaction may be reused. An external
 * transaction client is rejected because postgres.js does not expose its current isolation.
 */
export async function runPgRepeatableReadTransaction<T>(
  sql: PgStoreClient,
  run: (tx: SQLClient) => Promise<T>
): Promise<T> {
  if (canStartPgTransaction(sql)) {
    return runPgTransaction(sql, run, { isolation: "repeatableRead" })
  }

  const isolation = activePgTransactions.get(sql)
  if (isolation === "repeatableRead" || isolation === "serializable") {
    return run(sql)
  }

  throw new Error(
    '[SixbPg] Selected object reads cannot join an unverified PostgreSQL transaction. Use storage.transaction(..., { isolation: "serializable" }) when reading through tx.objects.'
  )
}

export function authLockKey(kind: string, ...parts: readonly string[]): string {
  return ["auth", kind, ...parts].join(":")
}

export async function lockAdvisoryKeys(sql: SQLClient, keys: readonly string[]): Promise<void> {
  const locks = [...new Set(keys)].sort().map(advisoryLockParts)
  if (locks.length === 0) return

  await sql`
    SELECT pg_advisory_xact_lock(locks.first_key, locks.second_key)
    FROM unnest(
      ${sql.array(locks.map(([first]) => first))}::integer[],
      ${sql.array(locks.map(([, second]) => second))}::integer[]
    ) WITH ORDINALITY AS locks(first_key, second_key, lock_order)
    ORDER BY locks.lock_order
  `
}

function advisoryLockParts(key: string): readonly [number, number] {
  const hash = createHash("sha256").update(key).digest()
  return [hash.readInt32BE(0), hash.readInt32BE(4)]
}

/** Whether `sql` already runs within a transaction, provider-owned or external. */
export function isWithinPgTransaction(sql: PgStoreClient): boolean {
  return !canStartPgTransaction(sql)
}

export function canStartPgTransaction(sql: PgStoreClient): sql is SQL {
  return (
    !pgTransactionClients.has(sql) &&
    typeof (sql as { readonly reserve?: unknown }).reserve === "function"
  )
}
