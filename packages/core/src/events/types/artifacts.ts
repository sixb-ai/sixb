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

/**
 * A comment on an artifact was added, resolved, opened again, or deleted. Whoever reads the
 * artifact receives it, and reads the comments again; a shared link's guest, only for a thread
 * started by a guest of the same link.
 */
export interface ArtifactCommentedEvent extends EventEnvelope {
  type: "artifact.commented"
  topic: "artifacts"
  partitionKey: string
  payload: {
    artifactId: string
    commentId: string
    /** The comment it replies to, for a reply. */
    parentId?: string
    /**
     * For a thread a guest started, the shared link they came through, by its grant: its guests
     * receive the event too. Without it, the thread is the team's, and no guest receives it.
     */
    shareGrantId?: string
    action: "created" | "resolved" | "reopened" | "deleted"
  }
}

export type ArtifactEvent = ArtifactUpdatedEvent | ArtifactCommentedEvent
