import type { DomainEventLog } from "../events/service"
import type { ArtifactVersionRecord } from "../storage/artifacts/types"

/**
 * Tells whoever reads each artifact that its latest version changed, as `artifact.updated`. The
 * writes are stored by now, so `emit` never fails them: an event lost on the way only leaves a
 * viewer showing what it read until it reads again.
 */
export async function announceArtifactUpdates(
  events: Pick<DomainEventLog, "emit">,
  latest: readonly ArtifactVersionRecord[]
): Promise<void> {
  if (latest.length === 0) return

  await events.emit(
    {
      events: latest.map((version) => ({
        type: "artifact.updated" as const,
        payload: {
          artifactId: version.artifactId,
          version: version.version,
          revision: version.revision,
          frozen: version.frozenAt !== undefined,
        },
        // A revision changes once: announcing it again is the same event.
        idempotencyKey: `artifact.updated:${version.artifactId}:${version.revision}`,
      })),
    },
    { source: "Sixb" }
  )
}
