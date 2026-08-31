import type { AgentMessagePart } from "@sixb/core"
import { isAgentToolResult } from "@sixb/core/internal/agents"
import { fileContentKey } from "./file-ref"
import type { AgentOutputAttachment } from "./output-attachments"

/** Promote rich tool-result files to user-facing message files and remove duplicate outputs. */
export function assistantPartsWithAttachments(
  parts: readonly AgentMessagePart[],
  outputAttachments: readonly AgentOutputAttachment[] = []
): AgentMessagePart[] {
  const result = [...parts]
  const seen = new Set(
    parts.flatMap((part) => (part.type === "file" ? [fileContentKey(part.fileRef)] : []))
  )
  const candidates = [
    ...parts.flatMap((part) => {
      if (
        part.type !== "tool-call" ||
        part.state !== "output-available" ||
        !isAgentToolResult(part.output)
      ) {
        return []
      }
      return part.output.content.flatMap((contentPart) =>
        contentPart.type === "file" ? [contentPart.fileRef] : []
      )
    }),
    ...outputAttachments.map((attachment) => attachment.fileRef),
  ]

  for (const fileRef of candidates) {
    const identity = fileContentKey(fileRef)
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push({ type: "file", fileRef })
  }
  return result
}
