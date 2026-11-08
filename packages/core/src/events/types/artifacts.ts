import type { EventEnvelope } from "../envelope"

/**
 * An artifact's latest version changed: its content was written, a version was created, which
 * froze it, or a restore put earlier content back. Whoever reads the artifact receives it, so a
 * viewer anywhere shows the change.
 */
export interface ArtifactUpdatedEvent extends EventEnvelope {
  type: "artifact.updated"
  topic: "artifacts"
  partitionKey: string
  payload: {
    artifactId: string
    /** The artifact's latest version after the change. */
    version: number
    /** The artifact's revision after the change: what was read at an earlier one is stale. */
    revision: number
    /** The latest version is frozen: it never changes again, and the next write opens another. */
    frozen: boolean
  }
}

export type ArtifactEvent = ArtifactUpdatedEvent
