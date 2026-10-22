import { type Principal, principalsEqual } from "../auth"
import type { ArtifactRecord, ArtifactStorage } from "../storage/artifacts/types"

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
 * each one. An access token never reaches what is shared, only its own artifacts.
 */
export interface ArtifactAccessRule {
  accessTo(artifact: ArtifactRecord): Promise<ArtifactAccess>
  /** How the caller reads the artifacts a conversation shares. */
  conversation(threadId: string): Promise<ConversationAccess>
}

export function createArtifactAccessRule(input: {
  readonly storage: ArtifactStorage
  readonly projectId: string
  /** `system` for code without a caller, `null` for a caller that reaches no artifact. */
  readonly caller: Principal | "system" | null
  /** `false` for an access token, which reaches only its own artifacts. */
  readonly sharing: boolean
  /** How the caller reads a conversation, by the thread-access rule. */
  readonly conversation: (threadId: string) => Promise<ConversationAccess>
}): ArtifactAccessRule {
  const { caller } = input

  const conversation = async (threadId: string): Promise<ConversationAccess> =>
    caller === null || !input.sharing ? null : input.conversation(threadId)

  const accessTo = async (artifact: ArtifactRecord): Promise<ArtifactAccess> => {
    if (caller === null) return "none"
    if (caller === "system" || principalsEqual(caller, artifact.owner)) return "owner"
    if (!input.sharing) return "none"

    const threadIds = await input.storage.listThreadIds({
      projectId: input.projectId,
      id: artifact.id,
    })

    let access: ArtifactAccess = "none"
    for (const threadId of threadIds) {
      const reads = await input.conversation(threadId)
      if (reads === "update") return "update"
      if (reads === "read") access = "read"
    }
    return access
  }

  return { accessTo, conversation }
}
