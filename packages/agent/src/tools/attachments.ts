import { type AgentToolAttachments, AgentToolPublicError } from "@sixb/core"
import type { AgentRunFileStore } from "@sixb/core/internal/agents"
import { openFileRef } from "@sixb/core/internal/blob-storage"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
import { workflowInputFileRefs } from "../workflow-input-attachments"

type AttachmentBlobStorage = Pick<AgentRunFileStore, "stat" | "open">

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

function unknownAttachment(key: string): AgentToolPublicError {
  return new AgentToolPublicError(
    `[SixbAgent] '${key}' is not an attachment of this run. Pass a key listed in $SIXB_ATTACHMENTS.`
  )
}
