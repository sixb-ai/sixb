import { join } from "node:path"
import { InMemoryBlobStorage, InMemoryBroker, InMemoryQueues, SixbHost } from "@sixb/core"
import { DuckLakeStorage } from "@sixb/ducklake"
import { SqliteStorage } from "@sixb/sqlite"
import { createDefinitions } from "./definitions"

/** What `process.ts` left in `SIXB_E2E_DIR`, as `sixb dev` opens it: a queue that starts empty. */
const stateDir = process.env.SIXB_E2E_DIR
if (!stateDir) throw new Error("[run-recovery fixture] SIXB_E2E_DIR is required.")

const { source, orders, published, erp, ordersSync, pipeline } = createDefinitions(() => {})

export const sixb = new SixbHost({
  id: "recovery-e2e",
  ontology: [],
  connectors: [erp],
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: join(stateDir, "storage") }),
  lakeStorage: new DuckLakeStorage({
    catalog: { type: "duckdb", path: join(stateDir, "lake", "catalog.ducklake") },
    dataPath: join(stateDir, "lake", "data"),
  }),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
  datasets: [source, orders, published],
  syncs: [ordersSync],
  pipelines: [pipeline],
})
