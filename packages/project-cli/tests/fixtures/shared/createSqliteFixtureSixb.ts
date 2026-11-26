import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  SixbHost,
} from "@sixb/core"
import { SqliteStorage } from "@sixb/sqlite"

/** A host on SQLite storage at `path`, for commands that read the schema's migration state. */
export function createSqliteFixtureSixb(options: { projectId: string; path: string }) {
  return new SixbHost({
    id: options.projectId,
    ontology: [],
    broker: new InMemoryBroker(),
    storage: new SqliteStorage({ path: options.path }),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}
