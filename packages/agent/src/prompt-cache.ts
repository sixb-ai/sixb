import { createHash } from "node:crypto"
import type { ModelCachingIntent } from "@sixb/core/models"

/**
 * How a conversation's model calls are cached. Its prompt is read again by its next turn, which can
 * come after a human pause, so a turn asks for a long lifetime; a child does too when it can wait on
 * a human decision (see {@link childCacheLifetime}). Both name the conversation, so a provider
 * keeps the turn and its children on the upstream that holds what they cached: a child shares its
 * whole prefix with the runs that continue it, and, in a provider sandbox, its system prompt with
 * siblings given the same tools. On a computer, each child's prompt names its own thread's files.
 */
export function conversationPromptCaching(input: {
  readonly projectId: string
  /** The conversation's thread: a child's parent thread, never its own. */
  readonly threadId: string
  readonly lifetime: NonNullable<ModelCachingIntent["lifetime"]>
}): ModelCachingIntent {
  return { lifetime: input.lifetime, key: conversationCacheKey(input.projectId, input.threadId) }
}

/**
 * A child's next read can come after a human decision when its calls can be held for approval, or
 * when it continues a run that paused, as it may pause again: long. Otherwise its next read is its
 * own next step, within the turn: default. A question its parent's turn leaves to the user pauses a
 * child too; that is rare, so a child that can only pause on one keeps the default.
 */
export function childCacheLifetime(input: {
  /** Whether its run's approval mode lets every call run without asking. */
  readonly runsEveryCall: boolean
  /** Whether it continues a run that paused. */
  readonly continues: boolean
}): NonNullable<ModelCachingIntent["lifetime"]> {
  return input.runsEveryCall && !input.continues ? "default" : "long"
}

/** Opaque and stable for a conversation: the provider learns neither the project nor the thread. */
function conversationCacheKey(projectId: string, threadId: string): string {
  const digest = createHash("sha256").update(projectId).update("\0").update(threadId).digest("hex")
  return `sixb_${digest.slice(0, 32)}`
}
