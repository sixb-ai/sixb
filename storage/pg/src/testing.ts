export interface PostgresStorageTestingAdapter {
  advanceConnectorConnectionTime(durationMs: number): void
}

const adapters = new WeakMap<object, PostgresStorageTestingAdapter>()

export function registerPostgresStorageTestingAdapter(
  storage: object,
  advanceConnectorConnectionTime: (durationMs: number) => void
): void {
  adapters.set(storage, { advanceConnectorConnectionTime })
}

export function getPostgresStorageTestingAdapter(storage: object): PostgresStorageTestingAdapter {
  const adapter = adapters.get(storage)
  if (!adapter) throw new Error("[SixbPg] Storage testing adapter is unavailable.")
  return adapter
}
