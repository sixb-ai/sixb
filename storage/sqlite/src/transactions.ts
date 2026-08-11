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
  readonly readonly?: boolean
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
  if (path !== ":memory:" && !options.readonly) mkdirSync(dirname(path), { recursive: true })
  const db = new SqliteDatabase(path, options.readonly ? { readonly: true } : undefined)
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA busy_timeout = 5000")
  return {
    db,
    ownsConnection: true,
    installFreshSchema: path === ":memory:" && !options.readonly,
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

/** Lets timers and request handlers run between bounded synchronous SQLite chunks. */
export function yieldSqliteEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
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
