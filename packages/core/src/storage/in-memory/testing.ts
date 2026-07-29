import type { InMemoryStorageSnapshot } from "."

export interface InMemoryStorageTestingAdapter {
  snapshot(): InMemoryStorageSnapshot
}

const testingAdapters = new WeakMap<object, InMemoryStorageTestingAdapter>()

export function registerInMemoryStorageTestingAdapter(
  storage: object,
  adapter: InMemoryStorageTestingAdapter
): void {
  testingAdapters.set(storage, adapter)
}

/** @internal Relative test-only access; intentionally absent from every package barrel. */
export function getInMemoryStorageTestingAdapter(storage: object): InMemoryStorageTestingAdapter {
  const adapter = testingAdapters.get(storage)
  if (!adapter) throw new Error("[Sixb] In-memory storage testing adapter is unavailable.")
  return adapter
}
