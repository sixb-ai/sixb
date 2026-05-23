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
