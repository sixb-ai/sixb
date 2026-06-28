import { existsSync } from "node:fs"
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import {
  defaultAgentImageCandidates,
  probeSmolvm,
  SmolvmSandboxFactory,
} from "@sixb/sandboxes-smolvm"
import { SqliteStorage } from "@sixb/sqlite"

// This example runs agents in a hardware-isolated smolvm microVM. Check the
// prerequisites up front and fail with actionable steps, rather than surfacing an
// opaque error on the agent's first bash call.
function requireSmolvm(): void {
  const probe = probeSmolvm("smolvm")
  if (!probe.ok) {
    throw new Error(
      [
        `[acme-corp] smolvm sandbox is unavailable: ${probe.message}`,
        "",
        "This example runs agents in a hardware-isolated smolvm microVM. One-time setup:",
        "  1. Install the `smolvm` binary (and ensure /dev/kvm exists on Linux).",
        "  2. Build the agent image: `bun run agent:image` (requires Docker or Podman).",
        "",
        "See sandboxes/smolvm/README.md for details.",
      ].join("\n")
    )
  }
  if (!defaultAgentImageCandidates().some((path) => existsSync(path))) {
    throw new Error(
      [
        "[acme-corp] smolvm agent image not found.",
        "",
        "Build it once with `bun run agent:image` (requires Docker or Podman), then re-run.",
        "",
        "See sandboxes/smolvm/README.md for details.",
      ].join("\n")
    )
  }
}

requireSmolvm()

export const sixb = createSixb({
  id: "acme-corp",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
  // Hardware-isolated microVM sandbox. Prerequisites are checked by requireSmolvm()
  // above. It boots offline from a local agent-image archive — strict gateway-only
  // egress, instant spin-up. See sandboxes/smolvm/README.md.
  sandboxes: new SmolvmSandboxFactory({ timeout: 30_000 }),
})
