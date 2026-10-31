import type { FileRef } from "../blob-storage/types"
import type { AgentMessageRecord } from "../storage/agents"
import { isAgentToolResult } from "./tool-result"

// A run's attachments are keyed by where they sit in its thread: a message's file part, or a file a
// tool result returned. `$SIXB_ATTACHMENTS` lists them by these keys, and a tool opens one by its
// key, wherever the tool runs.

/** A file a message exposes as an attachment, with its key and where it sits in the message. */
export interface MessageAttachmentFile {
  readonly fileRef: FileRef
  readonly partIndex: number
  readonly key: string
  readonly contentPath: string
  readonly sandboxName: string
  readonly origin: "message-file" | "tool-result-file"
}

export function attachmentKey(messageId: string, partIndex: number): string {
  return `${messageId}:${partIndex}`
}

export function toolResultAttachmentKey(
  messageId: string,
  partIndex: number,
  contentIndex: number
): string {
  return `${messageId}:${partIndex}:tool-result:${contentIndex}`
}

/** The id of the message an attachment key names, or null when the key is malformed. */
export function attachmentKeyMessageId(key: string): string | null {
  return /^(.+?):\d+(?::tool-result:\d+)?$/.exec(key)?.[1] ?? null
}

/** The attachment with this key in a message, as `$SIXB_ATTACHMENTS` would list it, or null. */
export function findMessageAttachment(message: AgentMessageRecord, key: string): FileRef | null {
  return listMessageAttachments(message).find((file) => file.key === key)?.fileRef ?? null
}

/**
 * Lists the files a message exposes as attachments: the user's file parts, and the files of real
 * agent tool results, each with its key, its path in the message and its sandbox name. The
 * `$SIXB_ATTACHMENTS` manifest and `ctx.attachments.open` both use it, so a key opens only what the
 * manifest lists.
 */
export function listMessageAttachments(message: AgentMessageRecord): MessageAttachmentFile[] {
  return message.parts.flatMap((part, partIndex): MessageAttachmentFile[] => {
    if (part.type === "file") {
      return [
        {
          fileRef: part.fileRef,
          partIndex,
          key: attachmentKey(message.id, partIndex),
          contentPath: `/parts/${partIndex}/fileRef`,
          sandboxName: String(partIndex),
          origin: "message-file",
        },
      ]
    }
    if (
      part.type !== "tool-call" ||
      part.state !== "output-available" ||
      !isAgentToolResult(part.output)
    ) {
      return []
    }
    return part.output.content.flatMap((contentPart, contentIndex) =>
      contentPart.type === "file"
        ? [
            {
              fileRef: contentPart.fileRef,
              partIndex,
              key: toolResultAttachmentKey(message.id, partIndex, contentIndex),
              contentPath: `/parts/${partIndex}/output/content/${contentIndex}/fileRef`,
              sandboxName: `tool-${partIndex}-${contentIndex}`,
              origin: "tool-result-file",
            },
          ]
        : []
    )
  })
}
