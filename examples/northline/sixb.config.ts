import { mkdirSync } from "node:fs"
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { DuckLakeStorage } from "@sixb/ducklake"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"
import { SqliteStorage } from "@sixb/sqlite"

const localLakePath = ".sixb/lake"
mkdirSync(localLakePath, { recursive: true })

export const sixb = createSixb({
  id: "northline",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new DuckLakeStorage({
    catalog: { type: "duckdb", path: `${localLakePath}/catalog.ducklake` },
    dataPath: `${localLakePath}/data`,
  }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
  sandboxes:
    process.env.SIXB_SANDBOX_PROVIDER === "smolvm"
      ? new SmolvmSandboxFactory({ image: process.env.SIXB_AGENT_IMAGE, timeout: 30_000 })
      : new LocalSandboxFactory({ timeout: 30_000 }),
  // No `onError`: the runtime prints every failure it reports, which is what this project wants.
  // A handler is for sending them somewhere — see docs/runtime/error-handling.md.
})
