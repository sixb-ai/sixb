import type { OntologyStorage } from ".."
import type { InMemoryOntologyState, InMemoryOntologyStorageTestHooks } from "./shared-state"

export interface InMemoryOntologyStorageTestingAdapter {
  setTestHooks(hooks: InMemoryOntologyStorageTestHooks): void
  snapshot(): InMemoryOntologyState
}

const testingAdapters = new WeakMap<object, InMemoryOntologyStorageTestingAdapter>()

export function registerInMemoryOntologyStorageTestingAdapter(
  storage: OntologyStorage,
  adapter: InMemoryOntologyStorageTestingAdapter
): void {
  testingAdapters.set(storage, adapter)
}

/** @internal Relative test-only access; intentionally absent from every package barrel. */
export function getInMemoryOntologyStorageTestingAdapter(
  storage: OntologyStorage
): InMemoryOntologyStorageTestingAdapter {
  const adapter = testingAdapters.get(storage)
  if (!adapter) {
    throw new Error("[Sixb] In-memory ontology storage testing adapter is unavailable.")
  }
  return adapter
}

export type { InMemoryOntologyStorageTestHooks } from "./shared-state"
