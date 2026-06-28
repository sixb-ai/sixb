import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import { SmolvmSandboxFactory } from "@sixb/sandboxes-smolvm"
import { SqliteStorage } from "@sixb/sqlite"

export const sixb = createSixb({
  id: "acme-corp",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
  // Hardware-isolated microVM sandbox. One-time setup: install the `smolvm`
  // binary (and /dev/kvm on Linux), then `bun run agent:image` to build the
  // agent image. It boots offline from that local archive — strict gateway-only
  // egress, instant spin-up. See sandboxes/smolvm/README.md.
  sandboxes: new SmolvmSandboxFactory({ timeout: 30_000 }),
})
