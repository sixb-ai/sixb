export interface SqliteStorageTestingAdapter {
  advanceConnectorConnectionTime(durationMs: number): void
}

const adapters = new WeakMap<object, SqliteStorageTestingAdapter>()

export function registerSqliteStorageTestingAdapter(
  storage: object,
  advanceConnectorConnectionTime: (durationMs: number) => void
): void {
  adapters.set(storage, {
    advanceConnectorConnectionTime,
  })
}

export function getSqliteStorageTestingAdapter(storage: object): SqliteStorageTestingAdapter {
  const adapter = adapters.get(storage)
  if (!adapter) throw new Error("[SixbSqlite] Storage testing adapter is unavailable.")
  return adapter
}
