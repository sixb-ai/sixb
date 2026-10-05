import type { Database } from "bun:sqlite"

export interface SqliteStorageTestingAdapter {
  advanceConnectorConnectionTime(durationMs: number): void
  /** The store's write connection, for tests that inspect tables no public read exposes. */
  readonly db: Database
}

const adapters = new WeakMap<object, SqliteStorageTestingAdapter>()

export function registerSqliteStorageTestingAdapter(
  storage: object,
  adapter: SqliteStorageTestingAdapter
): void {
  adapters.set(storage, adapter)
}

export function getSqliteStorageTestingAdapter(storage: object): SqliteStorageTestingAdapter {
  const adapter = adapters.get(storage)
  if (!adapter) throw new Error("[SixbSqlite] Storage testing adapter is unavailable.")
  return adapter
}
