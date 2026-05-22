import { createHash } from "node:crypto"
import type { SQL } from "bun"

export async function runPgTransaction<T>(sql: SQL, run: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(run)
}

export function authLockKey(kind: string, ...parts: readonly string[]): string {
  return ["auth", kind, ...parts].join(":")
}

export async function lockAdvisoryKeys(sql: SQL, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    const [first, second] = advisoryLockParts(key)
    await sql`SELECT pg_advisory_xact_lock(${first}, ${second})`
  }
}

function advisoryLockParts(key: string): readonly [number, number] {
  const hash = createHash("sha256").update(key).digest()
  return [hash.readInt32BE(0), hash.readInt32BE(4)]
}
