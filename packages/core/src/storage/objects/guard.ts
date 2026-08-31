import type { ObjectReadScopeFactory, ObjectReadStorage, ObjectStorage } from "./types"

export interface ObjectReadStorageCallGuard {
  assertAvailable(): void
  run<TResult>(operation: () => Promise<TResult>): Promise<TResult>
}

/** Validate the required runtime capability before any facade can expose broad object reads. */
export function requireObjectReadScopeFactory(storage: ObjectStorage): ObjectReadScopeFactory {
  if (typeof storage.createSelectedReadScope !== "function") {
    throw new Error(
      "[Sixb] Object storage provider must implement ObjectReadScopeFactory to create selected object readers."
    )
  }
  return storage
}

/**
 * Guard every selected-reader terminal without proxying the provider reader.
 *
 * First-party providers freeze their readers. A Proxy cannot substitute a frozen own method
 * without violating JavaScript's invariants, so operation and lifetime guards use this explicit
 * facade instead.
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
    getByPrimaryIdBatch: (input) => guard.run(() => reader.getByPrimaryIdBatch(input)),
    listLinksBatch: (input) => guard.run(() => reader.listLinksBatch(input)),
    queryLinks: (input) => guard.run(() => reader.queryLinks(input)),
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
