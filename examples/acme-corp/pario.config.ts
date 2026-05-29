import { LocalBlobStorage } from "@pario/blob-local"
import { createPario, InMemoryBroker, InMemoryQueues } from "@pario/core"
import { LocalLakeStorage } from "@pario/lake-local"
import { SqliteStorage } from "@pario/sqlite"

export const pario = createPario({
  id: "acme-corp",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".pario" }),
  lakeStorage: new LocalLakeStorage({ path: ".pario/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".pario" }),
  queues: new InMemoryQueues(),
})
