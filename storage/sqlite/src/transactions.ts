import type { Database } from "bun:sqlite"
import { Database as SqliteDatabase } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export interface SqliteStoreConnection {
  readonly db: Database
  readonly ownsConnection: boolean
  readonly installFreshSchema: boolean
}

export interface SqliteStoreConnectionOptions {
  readonly path?: string
  readonly connection?: SqliteStoreConnection
}

export function openSqliteStoreConnection(
  options: SqliteStoreConnectionOptions = {}
): SqliteStoreConnection {
  if (options.connection) {
    return {
      db: options.connection.db,
      ownsConnection: false,
      installFreshSchema: false,
    }
  }

  const path = options.path ?? ":memory:"
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  return {
    db: new SqliteDatabase(path),
    ownsConnection: true,
    installFreshSchema: path === ":memory:",
  }
}

export function closeSqliteStoreConnection(connection: SqliteStoreConnection): void {
  if (connection.ownsConnection) {
    connection.db.close()
  }
}

const activeImmediateTransactions = new WeakSet<Database>()

export function runImmediateTransaction<T>(db: Database, run: () => T): T {
  if (activeImmediateTransactions.has(db)) {
    return run()
  }

  db.run("BEGIN IMMEDIATE")
  activeImmediateTransactions.add(db)

  try {
    const result = run()
    db.run("COMMIT")
    return result
  } catch (error) {
    rollbackQuietly(db)
    throw error
  } finally {
    activeImmediateTransactions.delete(db)
  }
}

export async function runImmediateTransactionAsync<T>(
  db: Database,
  run: () => Promise<T> | T
): Promise<T> {
  if (activeImmediateTransactions.has(db)) {
    return run()
  }

  db.run("BEGIN IMMEDIATE")
  activeImmediateTransactions.add(db)

  try {
    const result = await run()
    db.run("COMMIT")
    return result
  } catch (error) {
    rollbackQuietly(db)
    throw error
  } finally {
    activeImmediateTransactions.delete(db)
  }
}

function rollbackQuietly(db: Database): void {
  try {
    db.run("ROLLBACK")
  } catch {
    // Preserve the original SQLite storage failure.
  }
}
