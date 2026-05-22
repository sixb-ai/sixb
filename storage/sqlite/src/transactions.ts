import type { Database } from "bun:sqlite"

export function runImmediateTransaction<T>(db: Database, run: () => T): T {
  db.run("BEGIN IMMEDIATE")

  try {
    const result = run()
    db.run("COMMIT")
    return result
  } catch (error) {
    rollbackQuietly(db)
    throw error
  }
}

function rollbackQuietly(db: Database): void {
  try {
    db.run("ROLLBACK")
  } catch {
    // Preserve the original SQLite storage failure.
  }
}
