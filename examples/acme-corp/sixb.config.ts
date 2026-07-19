import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { SqliteStorage } from "@sixb/sqlite"

export const sixb = createSixb({
  id: "acme-corp",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
  // `bun run webhooks:demo` includes a deliberate handler failure that exercises this hook.
  onError(error, context) {
    console.error(
      `[Sixb onError Callback] [AcmeCorp] ${context.run.kind} run '${context.run.runId}' failed (${context.notificationId}):`,
      error
    )
  },
  sandboxes: new LocalSandboxFactory({
    timeout: 30_000,
    env: {
      HOME: "/tmp",
    },
  }),
})
