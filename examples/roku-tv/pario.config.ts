import { LocalBlobStorage } from "@pario/blob-local"
import { createPario, InMemoryBroker, InMemoryQueues } from "@pario/core"
import { LocalLakeStorage } from "@pario/lake-local"
import { SqliteStorage } from "@pario/sqlite"

const blobStorage = new LocalBlobStorage({ basePath: ".pario" })

export const pario = createPario({
  id: "roku-tv",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".pario" }),
  lakeStorage: new LocalLakeStorage({ path: ".pario/lake" }),
  blobStorage,
  queues: new InMemoryQueues(),
})
