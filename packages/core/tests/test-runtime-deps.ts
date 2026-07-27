import { InMemoryBlobStorage } from "../src/blob-storage"
import { InMemoryBroker } from "../src/broker"
import { InMemoryLakeStorage } from "../src/lake-storage"
import { InMemoryQueues } from "../src/queues"
import { InMemoryStorage } from "../src/storage"

/**
 * Helper to create test runtime dependencies for Sixb tests.
 * Uses the real InMemory* implementations with no test-only duplicates.
 */
export function createTestRuntimeDeps() {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  return {
    blobStorage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    storage,
    queues: new InMemoryQueues(),
  }
}

/** Waits for an eventually consistent runtime boundary without relying on arbitrary sleeps. */
export async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000
): Promise<T> {
  const startedAt = Date.now()
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for condition.")
    }
    await Bun.sleep(10)
  }
}
