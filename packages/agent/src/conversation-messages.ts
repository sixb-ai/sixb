import { toModelMessages } from "@sixb/core/internal/agents"
import type { ModelCachingIntent, ModelMessage, ModelReasoning } from "@sixb/core/models"
import type { SentSettings } from "./agent-prompt"
import {
  attachmentKey,
  type PreparedAgentAttachmentContext,
  toolResultAttachmentKey,
} from "./attachments"
import { type ConversationReaders, conversationAuthors } from "./message-authors"
import { userMessageTimes } from "./message-times"
import { conversationPromptCaching } from "./prompt-cache"
import type { LoadedAgentThreadModelContext } from "./thread-context"
import { toolFilesStepKey } from "./tools/result-media"

/**
 * A conversation's history as its model calls send it: each user message closed by when it was
 * sent and who wrote it, its attachments inline, and the files each step's tools showed. Every
 * part comes from stored data, so a turn, and the summary that continues it, send the bytes the
 * turn before sent.
 */
export function conversationModelMessages(input: {
  readonly threadContext: LoadedAgentThreadModelContext
  readonly attachmentContext?: PreparedAgentAttachmentContext
  /** The thread and who can read it; without it the model is told nothing of its people. */
  readonly conversation?: ConversationReaders
  /** The project's time zone and locale, for a message whose run captured none. */
  readonly project: SentSettings
}): ModelMessage[] {
  const { threadContext, attachmentContext } = input
  const sentTimes = userMessageTimes(threadContext.history, input.project)
  const authors = input.conversation
    ? conversationAuthors({
        conversation: input.conversation,
        messages: threadContext.retainedMessages,
      })
    : undefined

  return toModelMessages(threadContext.modelMessages, {
    // When, then who wrote it: `<sixb_author>` stays the message's last tag. Who takes part is in
    // the system prompt, so no message changes when the next one comes.
    userMessageSuffix: (message) => {
      if (!message.id) return undefined

      const closing = [sentTimes.get(message.id), authors?.byMessageId.get(message.id)]
      return closing.filter(Boolean).join("\n") || undefined
    },
    fileText: ({ message, partIndex }) =>
      message.id
        ? attachmentContext?.promptTextByPartKey.get(attachmentKey(message.id, partIndex))
        : undefined,
    fileData: ({ message, partIndex }) =>
      message.id
        ? attachmentContext?.modelFileDataByPartKey.get(attachmentKey(message.id, partIndex))
        : undefined,
    toolResultFileText: ({ message, partIndex, contentIndex }) =>
      message.id
        ? attachmentContext?.promptTextByPartKey.get(
            toolResultAttachmentKey(message.id, partIndex, contentIndex)
          )
        : undefined,
    afterToolResults: ({ message, partIndex }) =>
      message.id
        ? attachmentContext?.toolFilesByStep?.get(toolFilesStepKey(message.id, partIndex))
        : undefined,
  })
}

/**
 * How a conversation's model calls reason and are cached. Thinking, effort and the cache intent
 * are part of the prefix a provider reuses, so every call that continues the conversation sends
 * the same: the turn's steps, and the summary that compacts it.
 */
export function conversationModelSettings(input: {
  readonly reasoning: ModelReasoning | undefined
  readonly projectId: string
  readonly threadId: string
}): { readonly reasoning?: ModelReasoning; readonly caching: ModelCachingIntent } {
  return {
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
    caching: conversationPromptCaching({
      projectId: input.projectId,
      threadId: input.threadId,
      lifetime: "long",
    }),
  }
}
