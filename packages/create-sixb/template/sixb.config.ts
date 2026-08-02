import { mkdirSync } from "node:fs"
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { DuckLakeStorage } from "@sixb/ducklake"
import { SqliteStorage } from "@sixb/sqlite"

const projectId = "sixb-app"
mkdirSync(".sixb/lake", { recursive: true })

export const sixb = createSixb({
  id: projectId,
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new DuckLakeStorage({
    catalog: {
      type: "duckdb",
      path: ".sixb/lake/metadata.ducklake",
    },
    dataPath: ".sixb/lake/data",
  }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb/blobs" }),
  queues: new InMemoryQueues(),
})
