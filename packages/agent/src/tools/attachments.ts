import { type AgentToolAttachments, AgentToolPublicError, type BlobStorage } from "@sixb/core"
import type { AgentRunThreads } from "@sixb/core/internal/agents"
import { openFileRef } from "@sixb/core/internal/blob-storage"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
import type { SubagentRunFile } from "@sixb/core/storage"
import { attachmentKeyMessageId, findMessageAttachment } from "../attachments"
import { workflowInputFileRefs } from "../workflow-input-attachments"

type AttachmentBlobStorage = Pick<BlobStorage, "stat" | "open">

/**
 * A chat's attachments: files of its thread's messages, by the key `$SIXB_ATTACHMENTS` lists. Like
 * the gateway's message file route, a key resolves only in a message of the run's own thread.
 */
export function threadToolAttachments(input: {
  readonly threads: Pick<AgentRunThreads, "message">
  readonly threadId: string
  readonly blobStorage: AttachmentBlobStorage
}): AgentToolAttachments {
  return {
    async open(key) {
      const messageId = attachmentKeyMessageId(key)
      const message = messageId && (await input.threads.message(messageId))
      const fileRef =
        message && message.threadId === input.threadId ? findMessageAttachment(message, key) : null
      if (!fileRef) throw unknownAttachment(key)
      return openFileRef(input.blobStorage, fileRef)
    },
  }
}

/** A workflow AI task's attachments: the files of its input, by their path such as `input.pdf`. */
export function workflowInputToolAttachments(input: {
  readonly input: WorkflowIOSnapshot
  readonly blobStorage: AttachmentBlobStorage
}): AgentToolAttachments {
  const fileRefs = new Map(workflowInputFileRefs(input.input).map((ref) => [ref.path, ref.fileRef]))
  return {
    async open(key) {
      const fileRef = fileRefs.get(key)
      if (!fileRef) throw unknownAttachment(key)
      return openFileRef(input.blobStorage, fileRef)
    },
  }
}

/** A child Agent's attachments: the files its parent handed over, by their path such as `q3.pdf`. */
export function handedToolAttachments(input: {
  readonly files: readonly SubagentRunFile[]
  readonly blobStorage: AttachmentBlobStorage
}): AgentToolAttachments {
  const fileRefs = new Map(input.files.map((file) => [file.path, file.fileRef]))
  return {
    async open(key) {
      const fileRef = fileRefs.get(key)
      if (!fileRef) throw unknownAttachment(key)
      return openFileRef(input.blobStorage, fileRef)
    },
  }
}

function unknownAttachment(key: string): AgentToolPublicError {
  return new AgentToolPublicError(
    `[SixbAgent] '${key}' is not an attachment of this run. Pass a key listed in $SIXB_ATTACHMENTS.`
  )
}
