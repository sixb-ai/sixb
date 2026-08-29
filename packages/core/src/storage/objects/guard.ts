import type { ObjectReadStorage } from "./types"

export interface ObjectReadStorageCallGuard {
  assertAvailable(): void
  run<TResult>(operation: () => Promise<TResult>): Promise<TResult>
}

/**
 * Wrap every reader leaf without proxying the provider object.
 *
 * Providers deliberately freeze readers. A Proxy cannot substitute methods on a frozen own
 * property without violating JavaScript's invariants, so operation/lifetime guards use this
 * explicit facade instead.
 */
export function createGuardedObjectReadStorage(
  reader: ObjectReadStorage,
  guard: ObjectReadStorageCallGuard
): ObjectReadStorage {
  const guarded: ObjectReadStorage = {
    queryCapabilities: () => {
      guard.assertAvailable()
      return reader.queryCapabilities()
    },
    getByPrimaryId: (input) => guard.run(() => reader.getByPrimaryId(input)),
    selectsObjectProperties: (input) => guard.run(() => reader.selectsObjectProperties(input)),
    listLinks: (input) => guard.run(() => reader.listLinks(input)),
    getByPrimaryIdMany: (input) => guard.run(() => reader.getByPrimaryIdMany(input)),
    listLinksMany: (input) => guard.run(() => reader.listLinksMany(input)),
    list: (input) => guard.run(() => reader.list(input)),
  }
  if (reader.queryObjects) {
    guarded.queryObjects = (input) => guard.run(() => reader.queryObjects!(input))
  }
  if (reader.countObjects) {
    guarded.countObjects = (input) => guard.run(() => reader.countObjects!(input))
  }
  if (reader.existsObjects) {
    guarded.existsObjects = (input) => guard.run(() => reader.existsObjects!(input))
  }
  if (reader.facetObjects) {
    guarded.facetObjects = (input) => guard.run(() => reader.facetObjects!(input))
  }
  return Object.freeze(guarded)
}
