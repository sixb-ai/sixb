import type { DomainEventLog } from "../events/service"
import type { ArtifactCommentRecord, ArtifactVersionRecord } from "../storage/artifacts/types"

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

/**
 * Tells whoever reads the artifact that one of its comments changed, as `artifact.commented`.
 * The change is stored by now, so `emit` never fails it.
 */
export async function announceArtifactComment(
  events: Pick<DomainEventLog, "emit">,
  comment: Pick<ArtifactCommentRecord, "artifactId" | "id" | "parentId">,
  action: "created" | "resolved" | "reopened" | "deleted"
): Promise<void> {
  await events.emit(
    {
      events: [
        {
          type: "artifact.commented" as const,
          payload: {
            artifactId: comment.artifactId,
            commentId: comment.id,
            ...(comment.parentId === undefined ? {} : { parentId: comment.parentId }),
            action,
          },
        },
      ],
    },
    { source: "Sixb" }
  )
}
