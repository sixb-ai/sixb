import type { ReservedSQL } from "../pg-client"

/** CREATE INDEX CONCURRENTLY on expressions/partial indexes waits for older snapshots.
 * A blocking pg_advisory_lock SELECT can hold one while waiting for the index builder,
 * producing a cycle. Try-lock in short statements and wait outside PostgreSQL instead. */
export async function lockPgPreparation(sql: ReservedSQL, key: string): Promise<void> {
  let delay = 25
  while (true) {
    const [row] = await sql<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS acquired`
    if (row?.acquired) return
    await Bun.sleep(delay)
    delay = Math.min(delay * 2, 500)
  }
}
