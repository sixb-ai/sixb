import { createHash } from "node:crypto"
import type { SQL, SQLClient } from "./pg-client"

export type PgStoreClient = SQL | SQLClient

export interface RunPgTransactionOptions {
  /** Open the transaction at an explicit isolation; omit for the server default. */
  readonly isolation?: "repeatableRead" | "serializable"
}

type PgTransactionIsolation = "unverifiedDefault" | "repeatableRead" | "serializable"

const activePgTransactions = new WeakMap<PgStoreClient, PgTransactionIsolation>()

export async function runPgTransaction<T>(
  sql: PgStoreClient,
  run: (tx: SQLClient) => Promise<T>,
  options: RunPgTransactionOptions = {}
): Promise<T> {
  if (!canStartPgTransaction(sql)) {
    return run(sql)
  }

  // porsager passes the callback a transaction-scoped client (a TransactionSql, which is an
  // ISql == SQLClient). The `as Promise<T>` only unwraps porsager's UnwrapPromiseArray return
  // type (our callbacks never return the pipelined-array form), not a structural cast.
  //
  // The isolation level is folded into `BEGIN` (`BEGIN ISOLATION LEVEL SERIALIZABLE`) rather than
  // a separate `SET TRANSACTION` statement: one round-trip instead of two, and the level is
  // guaranteed to take effect before any data statement of the transaction runs.
  const isolation = options.isolation ?? "unverifiedDefault"
  const trackedRun = async (tx: SQLClient): Promise<T> => {
    activePgTransactions.set(tx, isolation)
    try {
      return await run(tx)
    } finally {
      activePgTransactions.delete(tx)
    }
  }

  if (isolation === "serializable") {
    return sql.begin("isolation level serializable", trackedRun) as Promise<T>
  }
  if (isolation === "repeatableRead") {
    return sql.begin("isolation level repeatable read", trackedRun) as Promise<T>
  }
  return sql.begin(trackedRun) as Promise<T>
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

function canStartPgTransaction(sql: PgStoreClient): sql is SQL {
  return typeof (sql as { readonly begin?: unknown }).begin === "function"
}
