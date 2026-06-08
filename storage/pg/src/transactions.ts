import { createHash } from "node:crypto"
import type { SQL, SQLClient } from "./pg-client"

export async function runPgTransaction<T>(
  sql: SQL,
  run: (tx: SQLClient) => Promise<T>
): Promise<T> {
  // porsager passes the callback a transaction-scoped client (a TransactionSql, which is an
  // ISql == SQLClient). The `as Promise<T>` only unwraps porsager's UnwrapPromiseArray return
  // type (our callbacks never return the pipelined-array form), not a structural cast.
  return sql.begin(run) as Promise<T>
}

export function authLockKey(kind: string, ...parts: readonly string[]): string {
  return ["auth", kind, ...parts].join(":")
}

export async function lockAdvisoryKeys(sql: SQLClient, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    const [first, second] = advisoryLockParts(key)
    await sql`SELECT pg_advisory_xact_lock(${first}, ${second})`
  }
}

function advisoryLockParts(key: string): readonly [number, number] {
  const hash = createHash("sha256").update(key).digest()
  return [hash.readInt32BE(0), hash.readInt32BE(4)]
}
