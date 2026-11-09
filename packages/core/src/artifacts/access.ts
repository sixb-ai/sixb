import { type Principal, principalsEqual } from "../auth"
import type { ArtifactRecord, ArtifactStorage } from "../storage/artifacts/types"
import { ArtifactRequestError } from "./errors"

/**
 * What the caller may do with an artifact.
 *
 * - `owner`: everything, deleting it included.
 * - `update`: read every version and publish the next one, as the owner, a participant of a
 *   conversation that shares it, or someone who edits an object that holds it.
 * - `read`: read every version, as someone who observes a conversation that shares it, or reads
 *   an object that holds it.
 * - `none`: nothing; the artifact exists but is not shared with the caller.
 */
export type ArtifactAccess = "owner" | "update" | "read" | "none"

/** How the caller reads a conversation: talking in it, only observing it, or not at all. */
export type ConversationAccess = "update" | "read" | null

/**
 * How the caller reaches an artifact through the objects that hold it: editing one, only reading
 * one, or through none.
 */
export type HolderAccess = "update" | "read" | null

/**
 * The one rule for who reaches an artifact.
 *
 * Its owner reaches it, and code without a caller reaches every artifact. Anyone else reaches an
 * artifact through what shares it, and gets the most any of them gives:
 *
 * - a conversation they read, which shares the artifact the Agent published a version in, or a
 *   fork of it copied: whoever owns or takes part in it may update the artifact, and an observer
 *   only reads it. Only a signed-in session reaches what conversations share.
 * - an object that holds it in a property: whoever reads the object and that property reads the
 *   artifact, and may update it when they may also edit the object's type. Every credential
 *   reaches what objects hold, an access token included.
 *
 * A shared link's visitor, a guest, reaches only what the objects their link shares hold, and only
 * reads it: their link shows objects, it never lets them change one. The artifact is shared whole,
 * at every version, whatever published each one. A caller that reaches no artifact gets `none`.
 *
 * A rule reads how the caller reaches each conversation and each artifact's holders once, so it
 * lives for one operation.
 */
export interface ArtifactAccessRule {
  accessTo(artifact: ArtifactRecord): Promise<ArtifactAccess>
  /**
   * What the caller may do when publishing the artifact's next version from a conversation, or
   * outside any without `threadId`. A version published in a conversation shares the artifact
   * there: that is how sharing starts. Its owner, and whoever may update it through an object,
   * publish from any conversation. Anyone else publishes from a conversation only when it already
   * shares the artifact, with the access they have there, so a version never shares someone else's
   * artifact in another conversation.
   */
  publishAccess(artifact: ArtifactRecord, threadId?: string): Promise<ArtifactAccess>
  /** How the caller reads the artifacts a conversation shares. */
  conversation(threadId: string): Promise<ConversationAccess>
}

export function createArtifactAccessRule(input: {
  readonly storage: ArtifactStorage
  readonly projectId: string
  /**
   * `system` for code without a caller, `guest` for a shared link's visitor, `null` for a caller
   * that reaches no artifact.
   */
  readonly caller: Principal | "system" | "guest" | null
  /** `false` unless the caller signed in with a session: anything else reaches no conversation. */
  readonly sharing: boolean
  /** How the caller reads a conversation, by the thread-access rule. */
  readonly conversation: (threadId: string) => Promise<ConversationAccess>
  /** How the caller reaches the artifact through the objects that hold it. */
  readonly holders: (artifact: ArtifactRecord) => Promise<HolderAccess>
}): ArtifactAccessRule {
  const { caller } = input
  const conversations = new Map<string, Promise<ConversationAccess>>()
  const holders = new Map<string, Promise<HolderAccess>>()

  const conversation = (threadId: string): Promise<ConversationAccess> => {
    if (caller === null || caller === "guest" || !input.sharing) return Promise.resolve(null)

    let reads = conversations.get(threadId)
    if (!reads) {
      reads = input.conversation(threadId)
      conversations.set(threadId, reads)
    }
    return reads
  }

  const throughObjects = (artifact: ArtifactRecord): Promise<HolderAccess> => {
    let reaches = holders.get(artifact.id)
    if (!reaches) {
      // A guest only reads, whatever their objects' type would let a member do.
      reaches = input
        .holders(artifact)
        .then((access) => (caller === "guest" && access !== null ? "read" : access))
      holders.set(artifact.id, reaches)
    }
    return reaches
  }

  /** `owner` or `none` when the answer needs no other source; `undefined` when it does. */
  const ownAccess = (artifact: ArtifactRecord): ArtifactAccess | undefined => {
    if (caller === null) return "none"
    if (caller === "guest") return undefined
    if (caller === "system" || principalsEqual(caller, artifact.owner)) return "owner"
    return undefined
  }

  const threadIdsOf = async (artifact: ArtifactRecord): Promise<readonly string[]> =>
    input.sharing
      ? input.storage.listThreadIds({ projectId: input.projectId, id: artifact.id })
      : []

  const accessTo = async (artifact: ArtifactRecord): Promise<ArtifactAccess> => {
    const own = ownAccess(artifact)
    if (own) return own

    let access: ArtifactAccess = "none"
    for (const threadId of await threadIdsOf(artifact)) {
      const reads = await conversation(threadId)
      if (reads === "update") return "update"
      if (reads === "read") access = "read"
    }

    // Objects come last: each holder is an object read again as the caller, which costs more
    // than a conversation's participants.
    return (await throughObjects(artifact)) ?? access
  }

  const publishAccess = async (
    artifact: ArtifactRecord,
    threadId?: string
  ): Promise<ArtifactAccess> => {
    if (threadId === undefined) return accessTo(artifact)

    const own = ownAccess(artifact)
    if (own) return own

    const shared = (await threadIdsOf(artifact)).includes(threadId)
    const here = shared ? await conversation(threadId) : null
    if (here === "update") return "update"

    // Whoever may update it through an object writes it from any conversation, as its owner does.
    if ((await throughObjects(artifact)) === "update") return "update"
    return here ?? "none"
  }

  return { accessTo, publishAccess, conversation }
}

/** Refuses an artifact the caller may not update: `not_shared`, or `read_only` for a reader. */
export function assertUpdatable(artifactId: string, access: ArtifactAccess): void {
  if (access === "none") {
    throw new ArtifactRequestError(
      "not_shared",
      `[Sixb] Artifact '${artifactId}' is not shared with you.`
    )
  }

  if (access === "read") {
    throw new ArtifactRequestError(
      "read_only",
      `[Sixb] You only read artifact '${artifactId}': you cannot change it or keep page data in it.`
    )
  }
}
