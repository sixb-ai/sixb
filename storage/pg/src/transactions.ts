import { createHash } from "node:crypto"
import type { SQL, SQLClient } from "./pg-client"

export type PgStoreClient = SQL | SQLClient

export interface RunPgTransactionOptions {
  /** Open the transaction at an explicit isolation level; omit for `READ COMMITTED`. */
  readonly isolation?: "repeatable-read" | "serializable"
}

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
  if (options.isolation === "serializable") {
    return sql.begin("isolation level serializable", run) as Promise<T>
  }
  if (options.isolation === "repeatable-read") {
    return sql.begin("isolation level repeatable read", run) as Promise<T>
  }
  return sql.begin(run) as Promise<T>
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
