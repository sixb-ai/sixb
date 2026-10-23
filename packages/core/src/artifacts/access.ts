import { type Principal, principalsEqual } from "../auth"
import type { ArtifactRecord, ArtifactStorage } from "../storage/artifacts/types"
import { ArtifactRequestError } from "./errors"

/**
 * What the caller may do with an artifact.
 *
 * - `owner`: everything, deleting it included.
 * - `update`: read every version and publish the next one, as the owner or a participant of a
 *   conversation that shares it.
 * - `read`: read every version, as someone who observes a conversation that shares it.
 * - `none`: nothing; the artifact exists but is not shared with the caller.
 */
export type ArtifactAccess = "owner" | "update" | "read" | "none"

/** How the caller reads a conversation: talking in it, only observing it, or not at all. */
export type ConversationAccess = "update" | "read" | null

/**
 * The one rule for who reaches an artifact.
 *
 * Its owner reaches it, and code without a caller reaches every artifact. Anyone else reaches an
 * artifact shared in a conversation they read: one the Agent published a version in, or a fork
 * of it copied. Whoever owns or takes part in that conversation may update the artifact; an
 * observer of it only reads. The artifact is shared whole, at every version, whatever published
 * each one. Only a signed-in session reaches what is shared: an access token, or a principal
 * without a credential, reaches only its own artifacts.
 *
 * A rule reads how the caller reads each conversation once, so it lives for one operation.
 */
export interface ArtifactAccessRule {
  accessTo(artifact: ArtifactRecord): Promise<ArtifactAccess>
  /**
   * What the caller may do when publishing the artifact's next version from a conversation, or
   * outside any without `threadId`. Its owner publishes from anywhere, and a version published in
   * a conversation shares the artifact there: that is how sharing starts. Anyone else publishes
   * from a conversation only when it already shares the artifact, with the access they have there,
   * so a version never shares someone else's artifact in another conversation.
   */
  publishAccess(artifact: ArtifactRecord, threadId?: string): Promise<ArtifactAccess>
  /** How the caller reads the artifacts a conversation shares. */
  conversation(threadId: string): Promise<ConversationAccess>
}

export function createArtifactAccessRule(input: {
  readonly storage: ArtifactStorage
  readonly projectId: string
  /** `system` for code without a caller, `null` for a caller that reaches no artifact. */
  readonly caller: Principal | "system" | null
  /** `false` unless the caller signed in with a session: anything else reaches only its own. */
  readonly sharing: boolean
  /** How the caller reads a conversation, by the thread-access rule. */
  readonly conversation: (threadId: string) => Promise<ConversationAccess>
}): ArtifactAccessRule {
  const { caller } = input
  const conversations = new Map<string, Promise<ConversationAccess>>()

  const conversation = (threadId: string): Promise<ConversationAccess> => {
    if (caller === null || !input.sharing) return Promise.resolve(null)

    let reads = conversations.get(threadId)
    if (!reads) {
      reads = input.conversation(threadId)
      conversations.set(threadId, reads)
    }
    return reads
  }

  /** `owner` or `none` when the answer needs no conversation; `undefined` when it does. */
  const ownAccess = (artifact: ArtifactRecord): ArtifactAccess | undefined => {
    if (caller === null) return "none"
    if (caller === "system" || principalsEqual(caller, artifact.owner)) return "owner"
    return input.sharing ? undefined : "none"
  }

  const threadIdsOf = (artifact: ArtifactRecord) =>
    input.storage.listThreadIds({ projectId: input.projectId, id: artifact.id })

  const accessTo = async (artifact: ArtifactRecord): Promise<ArtifactAccess> => {
    const own = ownAccess(artifact)
    if (own) return own

    let access: ArtifactAccess = "none"
    for (const threadId of await threadIdsOf(artifact)) {
      const reads = await conversation(threadId)
      if (reads === "update") return "update"
      if (reads === "read") access = "read"
    }
    return access
  }

  const publishAccess = async (
    artifact: ArtifactRecord,
    threadId?: string
  ): Promise<ArtifactAccess> => {
    if (threadId === undefined) return accessTo(artifact)

    const own = ownAccess(artifact)
    if (own) return own

    if (!(await threadIdsOf(artifact)).includes(threadId)) return "none"

    const reads = await conversation(threadId)
    return reads === null ? "none" : reads
  }

  return { accessTo, publishAccess, conversation }
}

/** Refuses an artifact the caller may not update: `not_shared`, or `read_only` for an observer. */
export function assertUpdatable(artifactId: string, access: ArtifactAccess): void {
  if (access === "none") {
    throw new ArtifactRequestError(
      "not_shared",
      `[Sixb] Artifact '${artifactId}' is not shared in a conversation you read.`
    )
  }

  if (access === "read") {
    throw new ArtifactRequestError(
      "read_only",
      `[Sixb] You read artifact '${artifactId}' as an observer: you cannot change it or keep page data in it.`
    )
  }
}
